import { expect } from 'chai'
import { streamPair } from '@libp2p/utils'
import type { Connection, Stream } from '@libp2p/interface'
import { ConnectionFailedError, UnsupportedProtocolError } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { Readable } from 'stream'
import { OceanP2P } from '../../../components/P2P/index.js'
import { handleProtocolCommands } from '../../../components/P2P/handleProtocolCommands.js'
import {
  getCachedPeerResolution,
  resetPeerResolutionCache
} from '../../../components/P2P/peerResolutionCache.js'
import { resetP2PCounters } from '../../../components/P2P/counters.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'

/**
 * What `sendTo` hands to libp2p, and what it does when a dial fails.
 *
 * The substance of these cases is the difference between dialling a *peer id* and dialling an
 * *address list*. Given a peer id, libp2p's dial queue loads the peer's addresses from the peer
 * store, falls back to peer routing when it has none, expands `dnsaddr` entries, applies the
 * connection gater and sorts what is left before dialling. Given an explicit list it does none
 * of that discovery - so an address the caller happens not to have is one that will not be
 * tried. These cases pin which path each caller gets, and that a caller-supplied address list
 * never ends up in the peer store, where it would outlive the request by 48 hours for every
 * other code path to dial.
 */

const PEER = '16Uiu2HAmLhRDqfufZiQnxvQs2XHhd6hwkLSPfjAQg1gH8wgRixiP'
const DHT_ADDR = '/ip4/198.51.100.7/tcp/9000'
const STORE_ADDR = '/ip4/10.2.2.2/tcp/9000'
const PINNED_ADDR = '/ip4/127.0.0.1/tcp/9000'

interface Recorded {
  /** What each `dial` was given: a peer id string, or the address list it was handed. */
  dialTargets: Array<{ byPeerId: boolean; value: string }>
  /** Address lists written to the peer store. */
  merged: string[][]
  /** Options each `dial` and `newStream` received. */
  dialOptions: any[]
  streamOptions: any[]
  dhtLookups: number
}

let recorded: Recorded

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

interface SenderOptions {
  peerStoreAddrs?: string[]
  dhtAddrs?: string[]
  /** Throws on each dial in turn; `undefined` at an index means that dial succeeds. */
  dialFailures?: Array<Error | undefined>
  /** Throws on each `newStream` in turn. */
  streamFailures?: Array<Error | undefined>
  handle?: () => Promise<P2PCommandResponse>
}

let connectionSeq = 0

function sender(options: SenderOptions): OceanP2P {
  const peerId = peerIdFromString(PEER)
  const handle =
    options.handle ??
    (() =>
      Promise.resolve({
        status: { httpStatus: 200 },
        stream: Readable.from(['payload'])
      }))
  let dialCount = 0
  let streamCount = 0
  return {
    _protocol: '/ocean/nodes/1.0.0',
    send: OceanP2P.prototype.send,
    normalizeMultiaddrs: OceanP2P.prototype.normalizeMultiaddrs,
    resolvePeer: OceanP2P.prototype.resolvePeer,
    sendTo: OceanP2P.prototype.sendTo,
    _libp2p: {
      getConnections: (): Connection[] => [],
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
        },
        merge: (unusedPeer: unknown, data: { multiaddrs: any[] }) => {
          recorded.merged.push(data.multiaddrs.map((ma) => ma.toString()))
          return Promise.resolve()
        }
      },
      peerRouting: {
        findPeer: () => {
          recorded.dhtLookups++
          if (options.dhtAddrs == null) {
            return Promise.reject(new Error('peer not found in the DHT'))
          }
          return Promise.resolve({
            multiaddrs: options.dhtAddrs.map((addr) => multiaddr(addr))
          })
        }
      },
      dial: async (target: any, opts: any): Promise<Connection> => {
        const byPeerId = !Array.isArray(target)
        recorded.dialTargets.push({
          byPeerId,
          value: byPeerId
            ? target.toString()
            : target.map((ma: any) => ma.toString()).join(',')
        })
        recorded.dialOptions.push(opts)
        const failure = options.dialFailures?.[dialCount]
        dialCount++
        if (failure) {
          throw failure
        }
        connectionSeq++
        const [client, server] = await streamPair()
        const incoming = {
          remotePeer: { toString: () => `12D3KooSenderPeer${connectionSeq}` },
          remoteAddr: { toString: () => `/ip4/10.254.0.${connectionSeq % 250}/tcp/1` }
        } as unknown as Connection
        void handleProtocolCommands.call(responderFor(handle), server, incoming)
        return {
          id: `send-connection-${connectionSeq}`,
          remotePeer: peerId,
          newStream: (unusedProtocol: string, streamOpts: any): Promise<Stream> => {
            recorded.streamOptions.push(streamOpts)
            const streamFailure = options.streamFailures?.[streamCount]
            streamCount++
            if (streamFailure) {
              return Promise.reject(streamFailure)
            }
            return Promise.resolve(client)
          },
          close: (): Promise<void> => Promise.resolve()
        } as unknown as Connection
      }
    }
  } as unknown as OceanP2P
}

const command = JSON.stringify({ command: 'testCommand' })

async function drain(result: { stream?: AsyncIterable<any> }): Promise<void> {
  if (!result.stream) return
  for await (const chunk of result.stream) {
    expect(chunk).to.not.equal(undefined)
  }
}

describe('sendTo hands address discovery to the dial queue', () => {
  beforeEach(() => {
    resetP2PCounters()
    resetPeerResolutionCache()
    recorded = {
      dialTargets: [],
      merged: [],
      dialOptions: [],
      streamOptions: [],
      dhtLookups: 0
    }
  })

  it('dials by peer id when it resolved the peer itself', async () => {
    const node = sender({ peerStoreAddrs: [STORE_ADDR] })
    const result = await OceanP2P.prototype.sendTo.call(node, PEER, command)
    await drain(result)

    expect(result.status.httpStatus).to.equal(200)
    expect(recorded.dialTargets.length).to.equal(1)
    expect(
      recorded.dialTargets[0].byPeerId,
      'a peer id lets libp2p do its own discovery, ordering and dnsaddr expansion'
    ).to.equal(true)
    expect(recorded.dialTargets[0].value).to.equal(PEER)
  })

  it('does not rewrite addresses the dial queue can already see', async () => {
    // A peer-store answer is already visible to the dial queue, and the peer store is a
    // datastore-backed write - repeating it on every send buys nothing.
    const node = sender({ peerStoreAddrs: [STORE_ADDR] })
    await drain(await OceanP2P.prototype.sendTo.call(node, PEER, command))
    expect(recorded.merged).to.deep.equal([])
  })

  it('publishes DHT-resolved addresses to the peer store before dialling by peer id', async () => {
    // These are the addresses libp2p would not have found: the dial queue only consults peer
    // routing when the peer store had nothing, and here it is about to be handed a peer id.
    const node = sender({ dhtAddrs: [DHT_ADDR] })
    await drain(await OceanP2P.prototype.sendTo.call(node, PEER, command))

    expect(recorded.merged).to.deep.equal([[`${DHT_ADDR}/p2p/${PEER}`]])
    expect(recorded.dialTargets[0].byPeerId).to.equal(true)
  })

  it('dials a caller-supplied address list verbatim and never stores it', async () => {
    // The direct-command path. Merging these would let an outside caller install addresses for
    // an arbitrary peer id that outlive the request by the peer store's 48-hour lifetime.
    const node = sender({ peerStoreAddrs: [STORE_ADDR] })
    await drain(await OceanP2P.prototype.sendTo.call(node, PEER, command, [PINNED_ADDR]))

    expect(recorded.dialTargets[0].byPeerId).to.equal(false)
    expect(recorded.dialTargets[0].value).to.equal(`${PINNED_ADDR}/p2p/${PEER}`)
    expect(recorded.merged, 'caller-supplied addresses must not persist').to.deep.equal(
      []
    )
    expect(recorded.dhtLookups, 'pinned addresses skip resolution entirely').to.equal(0)
  })

  it('keeps runOnLimitedConnection on both the dial and the stream', async () => {
    // Commands have to work over a relay before hole punching upgrades the connection.
    const node = sender({ peerStoreAddrs: [STORE_ADDR] })
    await drain(await OceanP2P.prototype.sendTo.call(node, PEER, command))

    expect(recorded.dialOptions[0].runOnLimitedConnection).to.equal(true)
    expect(recorded.streamOptions[0].runOnLimitedConnection).to.equal(true)
  })
})

describe('sendTo reacts to a failure by its category', () => {
  beforeEach(() => {
    resetP2PCounters()
    resetPeerResolutionCache()
    recorded = {
      dialTargets: [],
      merged: [],
      dialOptions: [],
      streamOptions: [],
      dhtLookups: 0
    }
  })

  it('drops the cached resolution when a dial against it fails', async () => {
    // Without this the cache serves the same bad address for its whole lifetime and the peer
    // stays unreachable - a cache that cannot be corrected is worse than no cache.
    const node = sender({
      peerStoreAddrs: [STORE_ADDR],
      // Both attempts fail, so the send really does give up and the entry really is dropped
      // rather than being rewritten by a successful retry.
      dialFailures: [
        new ConnectionFailedError('no route to host'),
        new ConnectionFailedError('no route to host')
      ]
    })
    await OceanP2P.prototype.resolvePeer.call(node, PEER)
    expect(getCachedPeerResolution(PEER), 'precondition: the entry exists').to.not.equal(
      undefined
    )

    const result = await OceanP2P.prototype.sendTo.call(node, PEER, command)

    expect(result.status.httpStatus).to.equal(404)
    expect(
      getCachedPeerResolution(PEER),
      'a failed dial must invalidate the entry it dialled'
    ).to.equal(undefined)
  })

  it('retries a dial failure and succeeds on the second attempt', async () => {
    const node = sender({
      peerStoreAddrs: [STORE_ADDR],
      dialFailures: [new ConnectionFailedError('connection reset by peer')]
    })
    const result = await OceanP2P.prototype.sendTo.call(node, PEER, command)
    await drain(result)

    expect(result.status.httpStatus).to.equal(200)
    expect(recorded.dialTargets.length).to.equal(2)
  })

  it('does not retry a peer that refuses the command protocol', async () => {
    // The dial succeeded, so the connection is healthy and a second dial plus a second
    // negotiation would be told exactly the same thing.
    const node = sender({
      peerStoreAddrs: [STORE_ADDR],
      streamFailures: [new UnsupportedProtocolError('protocol not supported')]
    })
    const result = await OceanP2P.prototype.sendTo.call(node, PEER, command)

    expect(result.status.httpStatus).to.equal(404)
    expect(
      recorded.dialTargets.length,
      'a protocol refusal must not cost a second dial'
    ).to.equal(1)
  })

  it('retries a stream open that ran out of budget on a healthy connection', async () => {
    const expired = new Error('the operation was aborted')
    expired.name = 'TimeoutError'
    const node = sender({
      peerStoreAddrs: [STORE_ADDR],
      streamFailures: [expired]
    })
    const result = await OceanP2P.prototype.sendTo.call(node, PEER, command)
    await drain(result)

    expect(result.status.httpStatus).to.equal(200)
    expect(recorded.streamOptions.length).to.equal(2)
  })
})
