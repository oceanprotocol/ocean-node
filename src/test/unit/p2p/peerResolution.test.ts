import { expect } from 'chai'
import type { Connection } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import { OceanP2P } from '../../../components/P2P/index.js'
import {
  RESOLVE_DHT_HIT,
  RESOLVE_MISS,
  RESOLVE_PEERSTORE_HIT,
  getP2PCounters,
  resetP2PCounters
} from '../../../components/P2P/counters.js'
import {
  invalidatePeerResolution,
  resetPeerResolutionCache
} from '../../../components/P2P/peerResolutionCache.js'

/**
 * Address resolution is the step that decides whether a command reaches a peer at all, and the
 * two things asserted here are the two ways it silently failed to.
 *
 * The first is `normalizeMultiaddrs`. libp2p rejects a dial whose address list mixes addresses
 * that carry a `/p2p/` component with addresses that do not, and the old resolution of that
 * mismatch was to keep whichever group was larger and throw the other away. For a NAT'd peer
 * the relay address is the one carrying the `/p2p/`, and it is nearly always outnumbered by
 * direct addresses that cannot work - so the only usable path was the one discarded. These
 * cases pin the address counts at which that happened.
 *
 * The second is the resolution cache. A cache in front of an address is only safe if a failed
 * dial can correct it, so the invalidation is asserted as behaviour rather than assumed from the
 * fact that a function exists.
 */

const PEER = '16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP'
const OTHER_PEER = '16Uiu2HAmHwzeVw7RpGopjZe6qNBJbzDDBdqtrSk7Gcx1emYsfgL4'
const RELAY = '16Uiu2HAmBKSeEP3v4tYEPsZsZv9VELinyMCsrVTJW9BvQeFXx28U'

/** The only path a NAT'd peer has: a reservation on a relay, carrying the relay's own peer id. */
const RELAY_ADDR = `/ip4/203.0.113.10/tcp/9000/p2p/${RELAY}/p2p-circuit`
const DIRECT_ONE = '/ip4/10.1.1.1/tcp/9000'
const DIRECT_TWO = '/ip4/10.1.1.2/tcp/9000'

const normalize = (addrs: string[]): string[] =>
  OceanP2P.prototype.normalizeMultiaddrs
    .call(
      {} as OceanP2P,
      PEER,
      addrs.map((addr) => multiaddr(addr))
    )
    .map((ma) => ma.toString())

interface ResolverOptions {
  connections?: string[]
  peerStoreAddrs?: string[]
  dhtAddrs?: string[]
}

/** Counts what each tier was asked, so a short-circuit can be shown rather than inferred. */
let tierCalls: { connections: number; peerStore: number; dht: number }
/** Records the options `findPeer` was called with, for the cache assertion. */
let findPeerOptions: any[]

function resolver(options: ResolverOptions): OceanP2P {
  return {
    normalizeMultiaddrs: OceanP2P.prototype.normalizeMultiaddrs,
    resolvePeer: OceanP2P.prototype.resolvePeer,
    _libp2p: {
      getConnections: (): Connection[] => {
        tierCalls.connections++
        return (options.connections ?? []).map(
          (addr) =>
            ({
              status: 'open',
              remoteAddr: multiaddr(addr)
            }) as unknown as Connection
        )
      },
      peerStore: {
        get: () => {
          tierCalls.peerStore++
          if (options.peerStoreAddrs == null) {
            return Promise.reject(new Error('peer not found in peer store'))
          }
          return Promise.resolve({
            addresses: options.peerStoreAddrs.map((addr) => ({
              multiaddr: multiaddr(addr)
            }))
          })
        }
      },
      peerRouting: {
        findPeer: (unusedPeer: unknown, opts: any) => {
          tierCalls.dht++
          findPeerOptions.push(opts)
          if (options.dhtAddrs == null) {
            return Promise.reject(new Error('peer not found in the DHT'))
          }
          return Promise.resolve({
            multiaddrs: options.dhtAddrs.map((addr) => multiaddr(addr))
          })
        }
      }
    }
  } as unknown as OceanP2P
}

describe('normalizeMultiaddrs keeps every path to a peer', () => {
  it('keeps the relay address of a NAT peer that also has two stale direct addresses', () => {
    // The exact shape that lost its only working path: one relay address carrying the relay's
    // /p2p/, outnumbered two to one by direct addresses that no longer answer.
    const result = normalize([RELAY_ADDR, DIRECT_ONE, DIRECT_TWO])

    expect(
      result.some((addr) => addr.includes('p2p-circuit')),
      'the relay address is the only path a NAT peer has and must survive'
    ).to.equal(true)
    expect(result).to.deep.equal([
      `${DIRECT_ONE}/p2p/${PEER}`,
      `${DIRECT_TWO}/p2p/${PEER}`,
      `${RELAY_ADDR}/p2p/${PEER}`
    ])
  })

  it('keeps the relay address when the counts tie', () => {
    // A tie used to resolve towards the without-peer-id group, i.e. against the relay.
    const result = normalize([RELAY_ADDR, DIRECT_ONE])

    expect(result).to.deep.equal([
      `${DIRECT_ONE}/p2p/${PEER}`,
      `${RELAY_ADDR}/p2p/${PEER}`
    ])
  })

  it('keeps direct addresses when the relay addresses outnumber them', () => {
    // The mirror case, which the count comparison also got wrong - in the other direction.
    const secondRelay = `/ip4/203.0.113.11/tcp/9000/p2p/${OTHER_PEER}/p2p-circuit`
    const result = normalize([RELAY_ADDR, secondRelay, DIRECT_ONE])

    expect(result).to.deep.equal([
      `${DIRECT_ONE}/p2p/${PEER}`,
      `${RELAY_ADDR}/p2p/${PEER}`,
      `${secondRelay}/p2p/${PEER}`
    ])
  })

  it('produces one consistent set, every address carrying the target peer id', () => {
    // The property libp2p actually requires: all or none. A mixed list is rejected outright.
    const result = normalize([RELAY_ADDR, DIRECT_ONE, `${DIRECT_TWO}/p2p/${PEER}`])

    expect(result.every((addr) => addr.endsWith(`/p2p/${PEER}`))).to.equal(true)
  })

  it('orders direct addresses before relayed ones', () => {
    // Same order libp2p's own sorter produces, so dialling by peer id and dialling this list
    // try the same paths in the same sequence.
    const result = normalize([RELAY_ADDR, DIRECT_ONE])
    expect(result.findIndex((addr) => addr.includes('p2p-circuit'))).to.equal(
      result.length - 1
    )
  })

  it('deduplicates addresses that differ only by an absent peer id', () => {
    const result = normalize([DIRECT_ONE, `${DIRECT_ONE}/p2p/${PEER}`])
    expect(result).to.deep.equal([`${DIRECT_ONE}/p2p/${PEER}`])
  })

  it('drops a direct address that terminates at a different peer', () => {
    // Appending the target id to it would fabricate a two-hop address that reaches nobody.
    const result = normalize([`${DIRECT_ONE}/p2p/${OTHER_PEER}`, DIRECT_TWO])
    expect(result).to.deep.equal([`${DIRECT_TWO}/p2p/${PEER}`])
  })
})

describe('resolvePeer reports which tier answered', () => {
  beforeEach(() => {
    resetP2PCounters()
    resetPeerResolutionCache()
    tierCalls = { connections: 0, peerStore: 0, dht: 0 }
    findPeerOptions = []
  })

  it('answers from an open connection without touching the peer store or the DHT', async () => {
    const resolution = await OceanP2P.prototype.resolvePeer.call(
      resolver({
        connections: [`${DIRECT_ONE}/p2p/${PEER}`],
        peerStoreAddrs: [DIRECT_TWO],
        dhtAddrs: [DIRECT_TWO]
      }),
      PEER
    )

    expect(resolution.source).to.equal('connection')
    expect(resolution.addresses.map((a) => a.toString())).to.deep.equal([
      `${DIRECT_ONE}/p2p/${PEER}`
    ])
    expect(tierCalls.peerStore, 'a live connection needs no lookup').to.equal(0)
    expect(tierCalls.dht).to.equal(0)
    // An open connection is a local answer, so it moves the local lane.
    expect(getP2PCounters()[RESOLVE_PEERSTORE_HIT]).to.equal(1)
    expect(getP2PCounters()[RESOLVE_DHT_HIT]).to.equal(0)
  })

  it('falls through to the peer store, then to the DHT, and says so', async () => {
    const fromStore = await OceanP2P.prototype.resolvePeer.call(
      resolver({ peerStoreAddrs: [DIRECT_ONE], dhtAddrs: [DIRECT_TWO] }),
      PEER
    )
    expect(fromStore.source).to.equal('peerstore')
    expect(tierCalls.dht).to.equal(0)

    resetPeerResolutionCache()
    const fromDht = await OceanP2P.prototype.resolvePeer.call(
      resolver({ dhtAddrs: [DIRECT_TWO] }),
      PEER
    )
    expect(fromDht.source).to.equal('dht')
    expect(getP2PCounters()[RESOLVE_DHT_HIT]).to.equal(1)
  })

  it('lets the DHT answer from its own local view on a normal lookup', async () => {
    await OceanP2P.prototype.resolvePeer.call(resolver({ dhtAddrs: [DIRECT_ONE] }), PEER)
    expect(findPeerOptions[0].useCache).to.equal(true)
  })

  it('forbids the DHT its local view when the caller is refreshing after a failure', async () => {
    // The whole point of a refresh is that local data has just been shown wrong; letting
    // kad-dht answer from the peer store would hand back the same stale address.
    await OceanP2P.prototype.resolvePeer.call(
      resolver({ dhtAddrs: [DIRECT_ONE] }),
      PEER,
      {
        usePeerStore: false
      }
    )
    expect(findPeerOptions[0].useCache).to.equal(false)
    expect(tierCalls.connections, 'a refresh skips every local tier').to.equal(0)
    expect(tierCalls.peerStore).to.equal(0)
  })

  it('reports a peer nothing could resolve as a miss', async () => {
    const resolution = await OceanP2P.prototype.resolvePeer.call(resolver({}), PEER)
    expect(resolution.source).to.equal('none')
    expect(resolution.addresses).to.deep.equal([])
    expect(getP2PCounters()[RESOLVE_MISS]).to.equal(1)
  })
})

describe('the resolution cache is correctable', () => {
  beforeEach(() => {
    resetP2PCounters()
    resetPeerResolutionCache()
    tierCalls = { connections: 0, peerStore: 0, dht: 0 }
    findPeerOptions = []
  })

  it('serves a second lookup without repeating the DHT walk', async () => {
    const node = resolver({ dhtAddrs: [DIRECT_ONE] })
    const first = await OceanP2P.prototype.resolvePeer.call(node, PEER)
    const second = await OceanP2P.prototype.resolvePeer.call(node, PEER)

    expect(first.source).to.equal('dht')
    expect(second.source).to.equal('cache')
    expect(second.addresses.map((a) => a.toString())).to.deep.equal(
      first.addresses.map((a) => a.toString())
    )
    expect(tierCalls.dht, 'the second lookup must not cost a second walk').to.equal(1)
    // A cache hit is not a lookup, so it moves no lane - the lanes measure where answers came
    // from, and this answer came from nowhere new.
    expect(getP2PCounters()[RESOLVE_DHT_HIT]).to.equal(1)
  })

  it('re-walks after a dial failure invalidates the entry', async () => {
    // This is the property that makes caching an address safe at all: an entry that has been
    // shown wrong must be droppable, or the cache becomes the reason a peer is unreachable.
    const node = resolver({ dhtAddrs: [DIRECT_ONE] })
    await OceanP2P.prototype.resolvePeer.call(node, PEER)
    expect(tierCalls.dht).to.equal(1)

    invalidatePeerResolution(PEER)

    const afterFailure = await OceanP2P.prototype.resolvePeer.call(node, PEER)
    expect(afterFailure.source).to.equal('dht')
    expect(tierCalls.dht, 'an invalidated entry must be re-resolved').to.equal(2)
  })

  it('reuses a recent miss instead of re-walking, and still yields to a real answer', async () => {
    const missing = resolver({})
    const firstMiss = await OceanP2P.prototype.resolvePeer.call(missing, PEER)
    const secondMiss = await OceanP2P.prototype.resolvePeer.call(missing, PEER)

    expect(firstMiss.source).to.equal('none')
    expect(secondMiss.source).to.equal('negative-cache')
    expect(tierCalls.dht, 'a remembered miss must not cost a second walk').to.equal(1)
    expect(getP2PCounters()[RESOLVE_MISS]).to.equal(1)

    // A negatively cached peer has to become reachable again without a restart. Invalidation is
    // one of the two ways that happens; the entry's own short lifetime is the other.
    invalidatePeerResolution(PEER)
    const recovered = await OceanP2P.prototype.resolvePeer.call(
      resolver({ dhtAddrs: [DIRECT_ONE] }),
      PEER
    )
    expect(recovered.source).to.equal('dht')
    expect(recovered.addresses.length).to.equal(1)
  })
})
