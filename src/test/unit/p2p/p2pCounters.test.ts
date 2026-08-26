import { expect } from 'chai'
import { streamPair } from '@libp2p/utils'
import type { Connection, Stream } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { Readable } from 'stream'
import { OceanP2P } from '../../../components/P2P/index.js'
import { handleProtocolCommands } from '../../../components/P2P/handleProtocolCommands.js'
import {
  RESOLVE_DHT_HIT,
  RESOLVE_MISS,
  RESOLVE_PEERSTORE_HIT,
  SENDTO_FAIL,
  SENDTO_OK,
  getP2PCounters,
  resetP2PCounters
} from '../../../components/P2P/counters.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'

/**
 * The resolution and `sendTo` counters exist to make the peer store's address lifetime
 * measurable: whether a resolution was answered locally or cost a DHT walk, and why a send
 * failed. A counter that is wired to the wrong branch is worse than no counter at all - it
 * would be read as evidence - so each lane is driven here through the shipped code path and
 * the movement is asserted, including that the lanes do not bleed into one another.
 */

const PEER_A = '16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP'
const ADDR_A = `/ip4/10.0.0.1/tcp/9000/p2p/${PEER_A}`
const ADDR_B = `/ip4/10.0.0.2/tcp/9000/p2p/${PEER_A}`

interface ResolverOptions {
  /** Addresses the peer store answers with; omitted means the lookup throws, as a miss does. */
  peerStoreAddrs?: string[]
  /** Addresses `peerRouting.findPeer` answers with; omitted means the walk fails. */
  dhtAddrs?: string[]
}

/** Tracks whether the DHT was consulted at all, so a peer-store hit can be shown to short-circuit. */
let dhtLookups = 0

function resolver(options: ResolverOptions): OceanP2P {
  return {
    normalizeMultiaddrs: OceanP2P.prototype.normalizeMultiaddrs,
    getPeerMultiaddrs: OceanP2P.prototype.getPeerMultiaddrs,
    _libp2p: {
      peerStore: {
        get: () => {
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
        findPeer: () => {
          dhtLookups++
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

/** A responder whose only interesting part is the status it answers with. */
function responderFor(handle: () => Promise<P2PCommandResponse>): OceanP2P {
  return {
    getConfig: () => ({
      denyList: { peers: [] as string[], ips: [] as string[] },
      rateLimit: 1_000_000,
      maxConnections: 1_000_000
    }),
    getCoreHandlers: () => ({ getHandler: () => ({ handle }) })
  } as unknown as OceanP2P
}

let senderCounter = 0

/**
 * A sender wired to a real `streamPair` with the shipped responder on the far side, so
 * `sendTo` runs its whole exchange - dial, stream open, command write, status frame - and the
 * outcome counter reflects what actually happened rather than a stubbed return.
 */
function sender(handle: () => Promise<P2PCommandResponse>): OceanP2P {
  const peerId = peerIdFromString(PEER_A)
  return {
    _protocol: '/ocean/nodes/1.0.0',
    send: OceanP2P.prototype.send,
    _libp2p: {
      getConnections: (): Connection[] => [],
      dial: async (): Promise<Connection> => {
        const [client, server] = await streamPair()
        senderCounter++
        const incoming = {
          remotePeer: { toString: () => `12D3KooCounterPeer${senderCounter}` },
          remoteAddr: { toString: () => `/ip4/10.255.0.${senderCounter % 250}/tcp/1` }
        } as unknown as Connection
        void handleProtocolCommands.call(responderFor(handle), server, incoming)
        return {
          id: `counter-connection-${senderCounter}`,
          remotePeer: peerId,
          newStream: (): Promise<Stream> => Promise.resolve(client),
          close: (): Promise<void> => Promise.resolve()
        } as unknown as Connection
      }
    }
  } as unknown as OceanP2P
}

describe('P2P counters', () => {
  beforeEach(() => {
    resetP2PCounters()
    dhtLookups = 0
  })

  it('counts a peer-store answer as a peer-store hit and never reaches the DHT', async () => {
    const addrs = await OceanP2P.prototype.getPeerMultiaddrs.call(
      resolver({ peerStoreAddrs: [ADDR_A], dhtAddrs: [ADDR_B] }),
      PEER_A
    )

    expect(addrs.map((a) => a.toString())).to.deep.equal([ADDR_A])
    expect(dhtLookups, 'a cached address must not cost a DHT walk').to.equal(0)
    const counters = getP2PCounters()
    expect(counters[RESOLVE_PEERSTORE_HIT]).to.equal(1)
    expect(counters[RESOLVE_DHT_HIT]).to.equal(0)
    expect(counters[RESOLVE_MISS]).to.equal(0)
  })

  it('counts a fall-through to the DHT as a DHT hit', async () => {
    const addrs = await OceanP2P.prototype.getPeerMultiaddrs.call(
      resolver({ dhtAddrs: [ADDR_B] }),
      PEER_A
    )

    expect(addrs.map((a) => a.toString())).to.deep.equal([ADDR_B])
    expect(dhtLookups).to.equal(1)
    const counters = getP2PCounters()
    expect(counters[RESOLVE_PEERSTORE_HIT]).to.equal(0)
    expect(counters[RESOLVE_DHT_HIT]).to.equal(1)
    expect(counters[RESOLVE_MISS]).to.equal(0)
  })

  it('counts a resolution that found nothing anywhere as a miss', async () => {
    const addrs = await OceanP2P.prototype.getPeerMultiaddrs.call(resolver({}), PEER_A)

    expect(addrs).to.deep.equal([])
    const counters = getP2PCounters()
    expect(counters[RESOLVE_MISS]).to.equal(1)
    expect(counters[RESOLVE_PEERSTORE_HIT] + counters[RESOLVE_DHT_HIT]).to.equal(0)
  })

  it('surfaces the counters through the existing network-stats output', async () => {
    await OceanP2P.prototype.getPeerMultiaddrs.call(
      resolver({ peerStoreAddrs: [ADDR_A] }),
      PEER_A
    )
    await OceanP2P.prototype.getPeerMultiaddrs.call(resolver({}), PEER_A)

    const stats = OceanP2P.prototype.getNetworkingStats.call({
      _libp2p: {
        getMultiaddrs: (): never[] => [],
        getConnections: (): Connection[] => []
      }
    } as unknown as OceanP2P)

    expect(stats.counters[RESOLVE_PEERSTORE_HIT]).to.equal(1)
    expect(stats.counters[RESOLVE_MISS]).to.equal(1)
    // a copy, so a reader of the stats cannot move the counters
    stats.counters[RESOLVE_MISS] = 99
    expect(getP2PCounters()[RESOLVE_MISS]).to.equal(1)
  })

  it('counts an unparsable peer id as a sendTo failure with its own reason', async () => {
    const response = await OceanP2P.prototype.sendTo.call(
      {} as OceanP2P,
      'not-a-peer-id',
      JSON.stringify({ command: 'testCommand' })
    )

    expect(response.status.httpStatus).to.equal(404)
    const counters = getP2PCounters()
    expect(counters[SENDTO_FAIL]).to.equal(1)
    expect(counters[`${SENDTO_FAIL}:invalid-peer`]).to.equal(1)
    expect(counters[SENDTO_OK]).to.equal(0)
  })

  it('counts a peer with no resolvable address separately from a dial failure', async () => {
    const response = await OceanP2P.prototype.sendTo.call(
      resolver({}),
      PEER_A,
      JSON.stringify({ command: 'testCommand' })
    )

    expect(response.status.httpStatus).to.equal(404)
    const counters = getP2PCounters()
    expect(counters[`${SENDTO_FAIL}:no-address`]).to.equal(1)
    expect(counters[`${SENDTO_FAIL}:dial`]).to.equal(0)
    // the failed resolution behind it is counted too, in its own lane
    expect(counters[RESOLVE_MISS]).to.equal(1)
  })

  it('counts a completed exchange as sendTo:ok', async () => {
    const response = await OceanP2P.prototype.sendTo.call(
      sender(() =>
        Promise.resolve({
          status: { httpStatus: 200 },
          stream: Readable.from(['payload'])
        })
      ),
      PEER_A,
      JSON.stringify({ command: 'testCommand' }),
      [ADDR_A]
    )

    expect(response.status.httpStatus).to.equal(200)
    for await (const chunk of response.stream) {
      expect(chunk).to.not.equal(undefined)
    }
    const counters = getP2PCounters()
    expect(counters[SENDTO_OK]).to.equal(1)
    expect(counters[SENDTO_FAIL]).to.equal(0)
  })

  it('counts a non-200 answer as a remote-status failure, not a transport one', async () => {
    const response = await OceanP2P.prototype.sendTo.call(
      sender(() =>
        Promise.resolve({
          status: { httpStatus: 400, error: 'nope' },
          stream: null
        })
      ),
      PEER_A,
      JSON.stringify({ command: 'testCommand' }),
      [ADDR_A]
    )

    expect(response.status.httpStatus).to.equal(400)
    const counters = getP2PCounters()
    expect(counters[`${SENDTO_FAIL}:remote-status`]).to.equal(1)
    expect(counters[`${SENDTO_FAIL}:dial`]).to.equal(0)
    expect(counters[`${SENDTO_FAIL}:stream-open`]).to.equal(0)
    expect(counters[SENDTO_OK]).to.equal(0)
  })
})
