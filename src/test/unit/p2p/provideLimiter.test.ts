import { expect } from 'chai'
import { streamPair } from '@libp2p/utils'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { Connection } from '@libp2p/interface'
import { OceanP2P } from '../../../components/P2P/index.js'
import {
  PROVIDE_CONCURRENCY,
  provideLimit
} from '../../../components/P2P/provideLimiter.js'
import { p2pAnnounceDDOS } from '../../../utils/cronjobs/p2pAnnounceDDOS.js'
import { OceanNode } from '../../../OceanNode.js'
import { lpFramedStream } from '../../../components/P2P/handleProtocolCommands.js'
import { sleep } from './lpTestUtils.js'

/**
 * Writing a DHT provider record is a `getClosestPeers` walk followed by a PUT to each of the
 * twenty peers it returns, so concurrency here multiplies by ~20 in outbound streams competing
 * with command traffic. Four independent paths provide in bulk, and they used to carry
 * separate bounds - one of them constructed per invocation, which is not a bound across
 * invocations at all. What matters is not that a ceiling exists but that it is *one* ceiling.
 */

interface ProvideMeter {
  peak: number
  calls: number
  maxSeenOnSharedLimiter: number
}

function stubbedP2PNode(meter: ProvideMeter, options: { failEvery?: number } = {}): any {
  let inFlight = 0
  const node: any = Object.create(OceanP2P.prototype)
  node._pendingAdvertise = []
  node._ddoDHT = { updated: 0, dht: new Map() }
  node.keyManager = { getPeerIdString: () => '12D3KooTestLocalPeer' }
  node.db = { ddo: { create: (): Promise<null> => Promise.resolve(null) } }
  node._libp2p = {
    services: { dht: { routingTable: { size: 20 } } },
    getConnections: () => [{}],
    contentRouting: {
      provide: async () => {
        meter.calls++
        const ordinal = meter.calls
        inFlight++
        meter.peak = Math.max(meter.peak, inFlight)
        // The limiter this call is queued behind has to be the module-level shared one, not a
        // private one the call site built: reading its live active count from inside a task is
        // what proves the identity rather than assuming it.
        meter.maxSeenOnSharedLimiter = Math.max(
          meter.maxSeenOnSharedLimiter,
          provideLimit.activeCount
        )
        try {
          await sleep(8)
          if (options.failEvery && ordinal % options.failEvery === 0) {
            throw new Error('provide failed: no peers responded')
          }
        } finally {
          inFlight--
        }
      }
    }
  }
  return node
}

const ddoBatch = (count: number, tag: string): any[] =>
  Array.from({ length: count }, (unused, index) => ({
    id: `did:op:${tag}-${index}`,
    metadata: { updated: 1 },
    event: { tx: '0xdeadbeef' }
  }))

describe('Bulk DHT provides share one concurrency ceiling', () => {
  it('never exceeds the ceiling when every bulk path runs at once', async () => {
    const meter: ProvideMeter = { peak: 0, calls: 0, maxSeenOnSharedLimiter: 0 }
    const node = stubbedP2PNode(meter)
    node._pendingAdvertise = ddoBatch(6, 'queued').map((ddo) => ddo.id)

    const oceanNode = {
      getDatabase: () =>
        Promise.resolve({
          ddo: {
            search: () =>
              Promise.resolve([
                {
                  found: 12,
                  hits: ddoBatch(12, 'republish').map((ddo) => ({ document: ddo }))
                }
              ])
          }
        }),
      getP2PNode: () => node
    } as unknown as OceanNode

    await Promise.all([
      node.storeAndAdvertiseDDOS(ddoBatch(10, 'publish-a')),
      node.storeAndAdvertiseDDOS(ddoBatch(10, 'publish-b')),
      node.storeAndAdvertiseDDOS(ddoBatch(10, 'publish-c')),
      node._flushAdvertiseQueue(),
      p2pAnnounceDDOS(oceanNode)
    ])

    expect(meter.calls).to.equal(48)
    expect(meter.peak).to.be.at.most(PROVIDE_CONCURRENCY)
    // three concurrent publishes alone would reach 15 with a per-invocation limiter
    expect(meter.peak).to.be.greaterThan(1)
    expect(meter.maxSeenOnSharedLimiter).to.be.greaterThan(0)
    expect(meter.maxSeenOnSharedLimiter).to.be.at.most(PROVIDE_CONCURRENCY)
  })

  it('reports a batch as incomplete when some of its provides failed', async () => {
    const meter: ProvideMeter = { peak: 0, calls: 0, maxSeenOnSharedLimiter: 0 }
    const node = stubbedP2PNode(meter, { failEvery: 3 })
    // Every failure used to be swallowed where the provide happens, so the per-item catch each
    // caller wraps it in was dead code and the completion counts were always N/N.
    const allAdvertised = await node.storeAndAdvertiseDDOS(ddoBatch(6, 'partial'))
    expect(allAdvertised).to.equal(false)
  })

  it('reports a batch as complete only when every provide succeeded', async () => {
    const meter: ProvideMeter = { peak: 0, calls: 0, maxSeenOnSharedLimiter: 0 }
    const node = stubbedP2PNode(meter)
    expect(await node.storeAndAdvertiseDDOS(ddoBatch(4, 'complete'))).to.equal(true)
  })
})

describe('Advertising a DID reports its real outcome', () => {
  it('rejects when the provider record could not be written', async () => {
    const node: any = Object.create(OceanP2P.prototype)
    node._pendingAdvertise = []
    node._libp2p = {
      services: { dht: { routingTable: { size: 20 } } },
      getConnections: () => [{}],
      contentRouting: {
        provide: () => Promise.reject(new Error('no peers responded to the PUT'))
      }
    }

    let failure: Error | undefined
    try {
      await node.advertiseString('did:op:failing')
    } catch (err) {
      failure = err as Error
    }
    expect(failure, 'a failed provide was swallowed').to.be.instanceOf(Error)
    expect(failure.message).to.equal('no peers responded to the PUT')
  })

  it('returns true when the provider record was written', async () => {
    const node: any = Object.create(OceanP2P.prototype)
    node._pendingAdvertise = []
    node._libp2p = {
      services: { dht: { routingTable: { size: 20 } } },
      getConnections: () => [{}],
      contentRouting: { provide: () => Promise.resolve() }
    }
    expect(await node.advertiseString('did:op:ok')).to.equal(true)
  })

  it('queues rather than fails when there is nowhere to write the record yet', async () => {
    const node: any = Object.create(OceanP2P.prototype)
    node._pendingAdvertise = []
    node._libp2p = {
      services: { dht: { routingTable: { size: 0 } } },
      getConnections: (): any[] => [],
      contentRouting: {
        provide: () =>
          Promise.reject(new Error('provide must not be attempted with no DHT peers'))
      }
    }
    // false means "not advertised yet", which is not the same as a failure, and the DID has to
    // survive for the next flush instead of being lost
    expect(await node.advertiseString('did:op:nobody-listening')).to.equal(false)
    expect(node._pendingAdvertise).to.deep.equal(['did:op:nobody-listening'])
  })
})

describe('A non-200 answer must not leave a stream open', () => {
  it('finishes the stream and withholds a body the caller would never read', async () => {
    const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
    const [clientStream, serverStream] = await streamPair()

    // a peer that refuses the command outright, exactly as the rate limiter does
    void (async () => {
      const lp = lpFramedStream(serverStream)
      await lp.read({ signal: AbortSignal.timeout(10_000) })
      await lp.write(
        Buffer.from(JSON.stringify({ httpStatus: 403, error: 'Rate limit exceeded' })),
        { signal: AbortSignal.timeout(10_000) }
      )
      await serverStream.close()
    })().catch(() => {})

    const connection = {
      id: 'pre-existing-connection',
      remotePeer: peerId,
      newStream: () => Promise.resolve(clientStream),
      close: () => Promise.resolve()
    } as unknown as Connection

    const node = {
      _libp2p: {
        dial: () => Promise.resolve(connection),
        getConnections: () => [connection]
      },
      _protocol: '/ocean/nodes/1.0.0',
      send: OceanP2P.prototype.send
    } as unknown as OceanP2P

    const result = await OceanP2P.prototype.sendTo.call(
      node,
      peerId.toString(),
      JSON.stringify({ command: 'status' }),
      ['/ip4/127.0.0.1/tcp/9000']
    )
    await sleep(50)

    expect(result.status.httpStatus).to.equal(403)
    // all teardown of a response body lives in its iterator, so handing back a stream that no
    // caller iterates is what leaked one muxer slot and one frame reader per refused command
    expect(result.stream).to.equal(undefined)
    expect(clientStream.status).to.not.equal('open')
  })
})
