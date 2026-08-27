/**
 * Derive the node's libp2p peerId string from `PRIVATE_KEY`, for use as `service.instance.id`.
 *
 * The node derives its peerId deterministically from `PRIVATE_KEY` before libp2p starts (see
 * `KeyManager` / `RawPrivateKeyProvider`, which do `peerIdFromPrivateKey(privateKeyFromRaw(bytes))`).
 * This replicates the minimal derivation so the telemetry bootstrap can stamp the peerId as the
 * per-node identity at boot, without constructing the full `KeyManager` or pulling in the config
 * builder / SDK.
 *
 * Fully defensive: returns `undefined` on any failure (missing/invalid key, libp2p import failure)
 * and never throws. The libp2p crypto modules are imported dynamically so a failure to load them is
 * caught here and degrades to a random UUID at the call site rather than blocking startup.
 */
import { telemetryLog } from './log.js'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length === 0 || clean.length % 2 !== 0) {
    throw new Error('PRIVATE_KEY is not an even-length hex string')
  }
  // Buffer is a Uint8Array subclass, so returning it satisfies the signature while using
  // the native hex decoder. The even-length/empty guard above still rejects malformed input.
  return Buffer.from(clean, 'hex')
}

export async function derivePeerIdFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  try {
    const raw = env.PRIVATE_KEY?.trim()
    if (!raw) return undefined
    const bytes = hexToBytes(raw)
    const { privateKeyFromRaw } = await import('@libp2p/crypto/keys')
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
    const key = privateKeyFromRaw(bytes)
    return peerIdFromPrivateKey(key).toString()
  } catch (e) {
    telemetryLog('could not derive peerId for service.instance.id', e)
    return undefined
  }
}
