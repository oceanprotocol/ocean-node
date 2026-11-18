import { createReadStream } from 'fs'
import { Readable } from 'stream'

// A service can run for weeks and Docker keeps everything it logged, so saving all of it would let
// one chatty container take unbounded memory at teardown and disk until expiry. The newest output
// is what's kept, because that is where a crash or a stop shows up.
export const SERVICE_LOGS_MAX_BYTES = 16 * 1024 * 1024

// Reading a stopped container's log ends by itself. These exist for a container that could not be
// stopped: its log never ends, and a teardown must not wait on it forever.
export const SERVICE_LOGS_IDLE_MS = 5_000
export const SERVICE_LOGS_MAX_MS = 60_000

// Saved files keep Docker's multiplexed framing rather than plain text, so they stream back in the
// same shape as a live log and clients need no change. Each frame is an 8-byte header —
// [stream type, 0, 0, 0, payload size as uint32 BE] — and the payload. Service containers never get
// a TTY, so their logs are always framed this way.
const FRAME_HEADER_BYTES = 8
const STDERR = 2

export interface DockerLogFrame {
  stream: number // 0 stdin, 1 stdout, 2 stderr (3 is Docker's own error stream)
  payload: Buffer
}

export function encodeDockerLogFrame(stream: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header[0] = stream
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/**
 * Throws on bytes that aren't a frame header (e.g. a TTY container's raw output) rather than
 * guessing: a misread size would garble everything after it. A frame cut off by the end of the
 * stream (a read that gave up mid-frame) is dropped, as its header claims bytes that never came.
 */
export async function* readDockerLogFrames(
  source: AsyncIterable<Buffer | string>
): AsyncGenerator<DockerLogFrame> {
  let pending: Buffer = Buffer.alloc(0)
  for await (const chunk of source) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes
    let offset = 0
    while (pending.length - offset >= FRAME_HEADER_BYTES) {
      const stream = pending[offset]
      if (
        stream > 3 ||
        pending[offset + 1] ||
        pending[offset + 2] ||
        pending[offset + 3]
      ) {
        throw new Error('not a multiplexed Docker log stream')
      }
      const size = pending.readUInt32BE(offset + 4)
      const end = offset + FRAME_HEADER_BYTES + size
      if (end > pending.length) break
      yield { stream, payload: pending.subarray(offset + FRAME_HEADER_BYTES, end) }
      offset = end
    }
    pending = pending.subarray(offset)
  }
}

/**
 * Logs are saved with Docker's per-entry timestamps (`timestamps: true`) only so `since` can be
 * applied when serving them; this separates the time from the text the container wrote.
 * `ms` is undefined for a payload without one.
 */
export function splitLogTimestamp(payload: Buffer): { ms?: number; body: Buffer } {
  const space = payload.indexOf(0x20)
  // Bounds around "2026-11-17T10:00:00.123456789Z" (30 characters, 35 with a numeric offset), so
  // a line that merely starts with a word and a space isn't handed to Date.parse.
  if (space >= 20 && space <= 40) {
    const ms = Date.parse(payload.toString('latin1', 0, space))
    if (!Number.isNaN(ms)) return { ms, body: payload.subarray(space + 1) }
  }
  return { body: payload }
}

export interface CollectedServiceLogs {
  // Left multiplexed and timestamped, so it can be written as is and later served like a live log,
  // `since` included. Starts with a note on stderr when older output was dropped, so a reader of
  // the log knows it is trimmed. Empty if the container logged nothing.
  data: Buffer
  droppedBytes: number
  // Reported so the caller can warn that the newest output may be missing.
  cutShort: boolean
}

/**
 * Trims to the newest `maxBytes` while reading rather than at the end, so a weeks-long log never
 * sits in memory in full. Drops whole frames, never part of one, so what's left is still valid
 * framing. When it gives up (`idleMs`/`maxMs`) it keeps what it read: at teardown there is no
 * second chance, and part of a log beats none.
 */
export async function collectServiceLogs(
  source: NodeJS.ReadableStream,
  {
    maxBytes = SERVICE_LOGS_MAX_BYTES,
    idleMs = SERVICE_LOGS_IDLE_MS,
    maxMs = SERVICE_LOGS_MAX_MS
  }: { maxBytes?: number; idleMs?: number; maxMs?: number } = {}
): Promise<CollectedServiceLogs> {
  const frames: Array<DockerLogFrame | undefined> = []
  let head = 0
  let keptBytes = 0
  let droppedBytes = 0
  let cutShort = false
  const giveUp = () => {
    cutShort = true
    ;(source as Readable).destroy?.()
  }
  const maxTimer = setTimeout(giveUp, maxMs)
  const idleTimer = setTimeout(giveUp, idleMs)
  try {
    for await (const { stream, payload } of readDockerLogFrames(
      source as AsyncIterable<Buffer>
    )) {
      idleTimer.refresh()
      // A copy, so the kept frames don't pin the (larger) chunks they were read from.
      frames.push({ stream, payload: Buffer.from(payload) })
      keptBytes += FRAME_HEADER_BYTES + payload.length
      // The newest frame stays even when it alone exceeds the limit: it's the last thing the
      // container said, and dropping it would leave nothing.
      while (keptBytes > maxBytes && head < frames.length - 1) {
        const size = FRAME_HEADER_BYTES + frames[head].payload.length
        frames[head] = undefined
        head++
        keptBytes -= size
        droppedBytes += size
      }
      if (head > 4096 && head * 2 > frames.length) {
        frames.splice(0, head)
        head = 0
      }
    }
  } catch (e) {
    // Destroying the source to give up ends the read with an error; anything else is real.
    if (!cutShort) throw e
  } finally {
    clearTimeout(maxTimer)
    clearTimeout(idleTimer)
  }

  const kept = frames.slice(head) as DockerLogFrame[]
  const parts = kept.map((f) => encodeDockerLogFrame(f.stream, f.payload))
  if (droppedBytes > 0) {
    // Stamped like the first kept entry, so a `since` filter keeps or drops it with that entry.
    const { ms } = splitLogTimestamp(kept[0].payload)
    const stamp = ms === undefined ? '' : `${new Date(ms).toISOString()} `
    const note =
      `${stamp}[ocean-node] ${droppedBytes} bytes of older output were dropped: ` +
      `the node keeps the last ${maxBytes} bytes of a container's log.\n`
    parts.unshift(encodeDockerLogFrame(STDERR, Buffer.from(note)))
  }
  return { data: Buffer.concat(parts), droppedBytes, cutShort }
}

/**
 * Matches a live `container.logs()` stream (same framing, no timestamps), so clients read saved
 * logs exactly as they read live ones. `since` takes Unix seconds, like Docker's own filter.
 */
export function savedServiceLogsStream(files: string[], since?: number): Readable {
  const sinceMs = since === undefined ? undefined : since * 1000
  async function* chunks(): AsyncGenerator<Buffer> {
    let batch: Buffer[] = []
    let batchBytes = 0
    for (const file of files) {
      for await (const { stream, payload } of readDockerLogFrames(
        createReadStream(file)
      )) {
        const { ms, body } = splitLogTimestamp(payload)
        if (sinceMs !== undefined && ms !== undefined && ms < sinceMs) continue
        const frame = encodeDockerLogFrame(stream, body)
        batch.push(frame)
        batchBytes += frame.length
        if (batchBytes >= 64 * 1024) {
          yield Buffer.concat(batch)
          batch = []
          batchBytes = 0
        }
      }
    }
    if (batch.length) yield Buffer.concat(batch)
  }
  return Readable.from(chunks(), { objectMode: false })
}
