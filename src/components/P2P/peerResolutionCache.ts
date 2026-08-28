import type { Multiaddr } from '@multiformats/multiaddr'
import { P2P_TIMEOUTS } from './timeouts.js'

/**
 * A short-lived cache of "which addresses did we last resolve for this peer", plus a shorter
 * negative cache of "this peer resolved to nothing".
 *
 * Why this is only worth having now. Caching a resolution is caching an address, and while the
 * peer store dropped addresses after one hour there was nothing to cache: the entry a lookup
 * produced was already at risk of being the last one before expiry, so a cache would mostly
 * have served addresses that were about to be discarded anyway. The peer store now keeps
 * addresses for the lifetime of a DHT provider record, so a resolution is a durable fact and
 * repeating the lookup for it is pure cost - and the lookups being repeated are not cheap: a
 * provider fan-out asks for the same five peers per DDO, and the indexer's decrypt loop asks
 * for the same decrypter over and over.
 *
 * **Invalidation on dial failure is the load-bearing part of this file, not the caching.** A
 * cache that hands out an address which no longer works, and cannot be told so, is strictly
 * worse than no cache: without it the next resolution would have gone to the DHT and found the
 * peer's new address, and with it the peer is unreachable for the whole lifetime of the entry.
 * So the contract every caller owes this module is: *a dial that failed against cached
 * addresses must call `invalidatePeerResolution` before it gives up.*
 *
 * The same rule is why `invalidatePeerResolution` clears the **negative** entry too, and why a
 * failed dial does not create one. A dial failure says "this address is wrong", which is a
 * statement about the address, not about whether the peer can be found; recording it as "this
 * peer does not resolve" would turn one bad address into a peer that is unreachable until the
 * negative entry expires, and would do it at exactly the moment the DHT is most likely to have
 * the answer.
 *
 * Lifetimes are deliberately short in absolute terms - tens of seconds against the peer
 * store's 48 hours - because this cache's job is collapsing bursts of identical lookups, not
 * remembering peers. The peer store is what remembers peers, and it is the tier immediately
 * behind this one.
 *
 * State is module-level, like the P2P counters and the shared provide limiter, for the same
 * reason: a node process runs exactly one P2P component, some of these methods are reached
 * through the prototype, and a per-instance field would add a `this` dependency for no gain.
 */

/** What a cached entry holds. Addresses are `Multiaddr`s, which are immutable value objects. */
interface CachedResolution {
  addresses: Multiaddr[]
  expiresAt: number
}

/**
 * Hard ceiling on tracked peers, positive and negative entries counted together.
 *
 * A cache with only a time bound is still a leak in one shape: a node that is asked for a
 * great many distinct peers inside one entry lifetime - a wide provider fan-out, or a hostile
 * caller supplying peer ids - grows the map with no upper bound. 1000 is far above what a
 * lifetime of this length can legitimately accumulate (a resolution is a network round trip,
 * and the whole cache exists because real workloads ask for the *same* handful of peers), and
 * far below any size at which a map of short address arrays matters against this process's
 * heap. It is a module constant rather than a knob on purpose: an operator has no information
 * with which to tune it, and it is not a budget that trades off against anything.
 */
export const PEER_RESOLUTION_CACHE_MAX_ENTRIES = 1000

const positive = new Map<string, CachedResolution>()
const negative = new Map<string, number>()

/** Reads it once per operation so a `Date.now()` is not paid twice per call. */
function pruneExpired(now: number): void {
  for (const [peer, entry] of positive) {
    if (entry.expiresAt <= now) {
      positive.delete(peer)
    }
  }
  for (const [peer, expiresAt] of negative) {
    if (expiresAt <= now) {
      negative.delete(peer)
    }
  }
}

/**
 * Enforces the entry ceiling. Expired entries go first - they are free - and only if that is
 * not enough are live entries dropped, oldest first. `Map` iterates in insertion order and
 * every write re-inserts, so "oldest" is "least recently written", which is the closest thing
 * to least-recently-useful available without tracking reads.
 */
function enforceCeiling(now: number): void {
  if (positive.size + negative.size <= PEER_RESOLUTION_CACHE_MAX_ENTRIES) {
    return
  }
  pruneExpired(now)
  while (positive.size + negative.size > PEER_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestNegative = negative.keys().next()
    if (oldestNegative.done !== true) {
      negative.delete(oldestNegative.value)
      continue
    }
    const oldestPositive = positive.keys().next()
    if (oldestPositive.done === true) {
      return
    }
    positive.delete(oldestPositive.value)
  }
}

/**
 * The addresses last resolved for `peer`, or `undefined` when there is no live entry.
 *
 * Returns a copy of the array so a caller that sorts or splices what it got - `sendTo` merges
 * and reorders addresses - cannot mutate the cached entry.
 */
export function getCachedPeerResolution(peer: string): Multiaddr[] | undefined {
  const entry = positive.get(peer)
  if (entry == null) {
    return undefined
  }
  if (entry.expiresAt <= Date.now()) {
    positive.delete(peer)
    return undefined
  }
  return [...entry.addresses]
}

/**
 * Records a successful resolution, and clears any negative entry for the same peer - a peer
 * that just resolved is by definition no longer one that does not resolve.
 *
 * An empty address list is not cached: that is a miss, and `cachePeerResolutionMiss` is how a
 * miss is recorded, with its own much shorter lifetime.
 */
export function cachePeerResolution(peer: string, addresses: Multiaddr[]): void {
  if (addresses.length === 0) {
    return
  }
  const now = Date.now()
  negative.delete(peer)
  positive.set(peer, {
    addresses: [...addresses],
    expiresAt: now + P2P_TIMEOUTS.resolveCacheMs
  })
  enforceCeiling(now)
}

/**
 * Records that `peer` resolved to nothing, so a burst of identical lookups does not each pay a
 * full DHT walk to learn the same thing.
 *
 * The lifetime is short for one specific reason: **a negatively-cached peer has to become
 * reachable again on its own, without a restart.** A peer that was offline when we looked is
 * the normal case, and it comes back on its own schedule; an entry that outlived a peer's
 * downtime would make this cache the reason the peer stayed unreachable.
 */
export function cachePeerResolutionMiss(peer: string): void {
  const now = Date.now()
  negative.set(peer, now + P2P_TIMEOUTS.resolveNegativeCacheMs)
  enforceCeiling(now)
}

/** Whether `peer` has a live negative entry, i.e. a recent lookup found nothing. */
export function isPeerResolutionNegativelyCached(peer: string): boolean {
  const expiresAt = negative.get(peer)
  if (expiresAt == null) {
    return false
  }
  if (expiresAt <= Date.now()) {
    negative.delete(peer)
    return false
  }
  return true
}

/**
 * Drops everything cached about `peer`, positive and negative.
 *
 * Called when a dial against cached addresses failed. Both halves go: the positive entry
 * because it has just been shown wrong, and the negative entry because a caller that got far
 * enough to dial is a caller who wants this peer now, and making it wait out a negative entry
 * before the DHT is consulted again is the opposite of what a failed dial should cause.
 */
export function invalidatePeerResolution(peer: string): void {
  positive.delete(peer)
  negative.delete(peer)
}

/**
 * Live counts, for the status/network-stats output. Deliberately not counters: these are the
 * cache's current occupancy, read on demand, and they say nothing about hit rates - the
 * resolution lanes in `counters.ts` are what report where answers came from.
 */
export function peerResolutionCacheStats(): {
  resolved: number
  unresolved: number
  resolvedTtlMs: number
  unresolvedTtlMs: number
} {
  pruneExpired(Date.now())
  return {
    resolved: positive.size,
    unresolved: negative.size,
    resolvedTtlMs: P2P_TIMEOUTS.resolveCacheMs,
    unresolvedTtlMs: P2P_TIMEOUTS.resolveNegativeCacheMs
  }
}

/** Test seam: only the unit tests empty the cache, a running node never does. */
export function resetPeerResolutionCache(): void {
  positive.clear()
  negative.clear()
}
