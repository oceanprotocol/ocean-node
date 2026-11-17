import { createReadStream } from 'fs'
import { Readable } from 'stream'

// The most of one container's log the node saves at teardown. A service can run for weeks, and
// Docker keeps everything it logged, so only the most recent output is kept: that is where a
// crash or a stop shows up.
export const SERVICE_LOGS_MAX_BYTES = 16 * 1024 * 1024

// Reading a stopped container's log ends by itself once Docker has sent it all. These bound the
// read when the container could not be stopped and is still logging.
export const SERVICE_LOGS_IDLE_MS = 5_000
export const SERVICE_LOGS_MAX_MS = 60_000

// A non-TTY container's stdout and stderr come multiplexed: each write is a frame with an 8-byte
// header — [stream type, 0, 0, 0, payload size as uint32 BE] — followed by the payload. Service
// containers never get a TTY, so their logs always have this shape.
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
 * Yields the frames of a multiplexed Docker log stream. Throws on bytes that are not a frame
 * header (e.g. the raw output of a TTY container). A frame cut off by the end of the stream is
 * dropped.
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
 * Splits off the RFC 3339 timestamp Docker puts in front of each entry when asked for
 * `timestamps: true`. `ms` is undefined for a payload without one.
 */
export function splitLogTimestamp(payload: Buffer): { ms?: number; body: Buffer } {
  const space = payload.indexOf(0x20)
  // "2026-11-17T10:00:00.123456789Z" is 30 characters, a numeric offset makes it 35.
  if (space >= 20 && space <= 40) {
    const ms = Date.parse(payload.toString('latin1', 0, space))
    if (!Number.isNaN(ms)) return { ms, body: payload.subarray(space + 1) }
  }
  return { body: payload }
}

export interface CollectedServiceLogs {
  // The frames to save, still multiplexed and timestamped, or empty if the container logged
  // nothing. Starts with a note on stderr when older output was dropped.
  data: Buffer
  droppedBytes: number
  // The read was cut short by `idleMs`/`maxMs`, so the newest output may be missing.
  cutShort: boolean
}

/**
 * Reads a container's whole log (`container.logs({ follow: true, timestamps: true })`) and keeps
 * the newest `maxBytes` of it, dropping whole frames from the start. Holds at most `maxBytes` in
 * memory. Gives up after `idleMs` without data or `maxMs` in all, keeping what it read.
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
      // Always keep the newest frame, even one bigger than the limit on its own.
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
 * Streams saved log files, oldest first, in the same multiplexed format as a live
 * `container.logs()` stream. With `since` (Unix seconds, like Docker's own filter) older entries
 * are left out. The timestamps the files were saved with are stripped, as a live stream has none.
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
