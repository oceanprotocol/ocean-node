/**
 * Counters for the two P2P paths that decide whether a command reaches its peer at all:
 * address resolution and `sendTo`.
 *
 * They exist so that a change to how long the peer store keeps an address can be *measured*
 * rather than argued about. A peer store that holds addresses long enough to match the
 * lifetime of a DHT provider record should show up here as resolutions moving from the DHT
 * lane to the peer-store lane, and as fewer `sendTo` failures attributed to `dial`; a peer
 * store that holds them too long would show up as the opposite - peer-store hits that then
 * fail to dial. Neither is visible without a count.
 *
 * Cost: one property increment on paths that are about to do network I/O, no timers, no
 * allocation per call. The keys are seeded at module load so the record keeps a single hidden
 * class and so a reader of the stats sees `0` for a lane that has not been used, which is
 * information, rather than a missing key, which is not.
 *
 * State is module-level rather than per-instance deliberately: `getPeerMultiaddrs` and
 * `sendTo` are both called on the prototype in places, and a node process only ever runs one
 * P2P component, so an instance field would only add a `this` dependency for no gain.
 *
 * Read them through `OceanP2P.getNetworkingStats()`.
 *
 * `countP2PEvent`/`countSendToFailure` are also the single tap for the OTel `p2pResolve`/
 * `p2pSendTo` counters (`../../telemetry/metrics.js`) - one place mapping these in-process
 * keys to OTel instrument attributes, instead of scattering `.add()` across the ~10 call
 * sites in `index.ts`. The two counter families can then never drift apart.
 */

import { p2pResolve, p2pSendTo } from '../../telemetry/metrics.js'

/** Address resolution outcomes. Exactly one is counted per `getPeerMultiaddrs` call that ran a lookup. */
export const RESOLVE_PEERSTORE_HIT = 'resolve:peerstore-hit'
export const RESOLVE_DHT_HIT = 'resolve:dht-hit'
export const RESOLVE_MISS = 'resolve:miss'

/** `sendTo` outcomes. Exactly one is counted per `sendTo` call that returns. */
export const SENDTO_OK = 'sendTo:ok'
export const SENDTO_FAIL = 'sendTo:fail'

/**
 * Why a `sendTo` did not deliver a 200. Counted as `sendTo:fail:<reason>` alongside the
 * `sendTo:fail` total, so a reader gets both the headline number and the breakdown without
 * having to sum anything.
 */
export const SENDTO_FAIL_REASONS = Object.freeze({
  /** The peer id string did not parse - nothing was dialled. */
  invalidPeer: 'invalid-peer',
  /** Resolution produced no address at all, so there was nothing to dial. */
  noAddress: 'no-address',
  /** Every dial failed, including the retry against DHT-resolved addresses. */
  dial: 'dial',
  /** The dial succeeded but the command stream could not be opened. */
  streamOpen: 'stream-open',
  /** The stream was open and the exchange failed or the connection went stale. */
  stream: 'stream',
  /** The peer answered, with a status other than 200. Transport worked; the command did not. */
  remoteStatus: 'remote-status',
  /** Every attempt was consumed without a return - only reachable through a bug. */
  attemptsExhausted: 'attempts-exhausted'
})

const counters: Record<string, number> = {
  [RESOLVE_PEERSTORE_HIT]: 0,
  [RESOLVE_DHT_HIT]: 0,
  [RESOLVE_MISS]: 0,
  [SENDTO_OK]: 0,
  [SENDTO_FAIL]: 0,
  ...Object.fromEntries(
    Object.values(SENDTO_FAIL_REASONS).map((reason) => [`${SENDTO_FAIL}:${reason}`, 0])
  )
}

/** `resolve:*` key -> the bounded `result` attribute the `ocean.p2p.resolve` counter carries. */
const RESOLVE_OTEL_RESULT: Record<string, string> = {
  [RESOLVE_PEERSTORE_HIT]: 'peerstore_hit',
  [RESOLVE_DHT_HIT]: 'dht_hit',
  [RESOLVE_MISS]: 'miss'
}

/**
 * Increments one counter. Unknown keys are accepted so a caller cannot silently lose a count.
 *
 * Also the tap for the OTel `p2pResolve`/`p2pSendTo` (ok side) counters: a resolve key adds
 * `{ result }`, `SENDTO_OK` adds `{ outcome: 'ok' }`. The `sendTo:fail` bookkeeping keys that
 * `countSendToFailure` drives through here are intentionally not mapped to an OTel attribute -
 * that call already reports the fail side directly, with the real reason, so mapping them here
 * too would double-count.
 */
export function countP2PEvent(key: string): void {
  counters[key] = (counters[key] ?? 0) + 1
  const result = RESOLVE_OTEL_RESULT[key]
  if (result) {
    p2pResolve.add(1, { result })
  } else if (key === SENDTO_OK) {
    p2pSendTo.add(1, { outcome: 'ok' })
  }
}

/**
 * Counts a `sendTo` failure twice on purpose: once against the headline `sendTo:fail` and once
 * against its reason, so the two are always consistent with each other. Also reports the OTel
 * `p2pSendTo` fail side, `{ outcome: 'fail', reason }`, with `reason` one of the bounded
 * `SENDTO_FAIL_REASONS` values - never the error message itself.
 */
export function countSendToFailure(reason: string): void {
  countP2PEvent(SENDTO_FAIL)
  countP2PEvent(`${SENDTO_FAIL}:${reason}`)
  p2pSendTo.add(1, { outcome: 'fail', reason })
}

/** A copy, so a caller reading the stats cannot mutate the counters. */
export function getP2PCounters(): Record<string, number> {
  return { ...counters }
}

/** Test seam: only the unit tests reset counters, a running node never does. */
export function resetP2PCounters(): void {
  for (const key of Object.keys(counters)) {
    counters[key] = 0
  }
}
