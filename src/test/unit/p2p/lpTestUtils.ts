import { streamPair } from '@libp2p/utils'
import type { Stream } from '@libp2p/interface'
import { lpFramedStream, LpFrameReader } from '../../../components/P2P/lpFraming.js'

/**
 * Shared fixtures for the length-prefixed protocol tests.
 *
 * Everything here runs over a real `streamPair` from the installed `@libp2p/utils` - the same
 * `AbstractStream` implementation the TCP/yamux transport builds on - so the read buffer, the
 * `message` dispatch, `pause()`/`resume()` and `abort()` all behave as they do on the wire.
 * Nothing here mocks the framing or the transport.
 */

/** Encodes `value` the way `lpStream` encodes a frame's length prefix. */
export function varintBytes(value: number): Uint8Array {
  const out: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 0x80)
    if (remaining > 0) {
      byte |= 0x80
    }
    out.push(byte)
  } while (remaining > 0)
  return Uint8Array.from(out)
}

/** One complete length-prefixed frame: varint length followed by the body. */
export function lpFrame(body: Uint8Array | string): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
  return Buffer.concat([Buffer.from(varintBytes(bytes.byteLength)), bytes])
}

export interface FramedPair {
  /** The peer under test writes raw bytes here, so a test can emit malformed framing. */
  peer: Stream
  /** The end being read, wrapped exactly as the protocol wraps it. */
  local: Stream
  reader: LpFrameReader
}

/**
 * A `streamPair` whose local end is wrapped by `lpFramedStream` + `LpFrameReader` in the same
 * tick, which is the ordering the protocol relies on: the reader counts `message` events, so it
 * has to be listening before any byte can be dispatched.
 */
export async function framedPair(): Promise<FramedPair> {
  const [peer, local] = await streamPair()
  const lp = lpFramedStream(local)
  const reader = new LpFrameReader(lp, local)
  return { peer, local, reader }
}

export const readSignal = (): AbortSignal => AbortSignal.timeout(5000)

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads until the reader throws, and reports whether the frame accounting called that end
 * clean. Returns the frames that were handed over before the end, so a test can assert that a
 * rejected transfer did not also hand out corrupt frames.
 */
export async function readUntilEnd(reader: LpFrameReader): Promise<{
  frames: Uint8Array[]
  error: Error
  cleanEnd: boolean
}> {
  const frames: Uint8Array[] = []
  for (;;) {
    try {
      frames.push(await reader.read({ signal: readSignal() }))
    } catch (err) {
      return { frames, error: err as Error, cleanEnd: reader.isCleanEnd(err) }
    }
  }
}
