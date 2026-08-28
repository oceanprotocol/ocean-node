import { expect } from 'chai'
import { ethers } from 'ethers'
import { Readable } from 'stream'
import {
  FindDdoHandler,
  resetDdoNotFoundCache
} from '../../components/core/handler/ddoHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { generateDDOHash } from '../../utils/asset.js'
import { P2P_TIMEOUTS } from '../../components/P2P/timeouts.js'
import {
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment,
  OverrideEnvConfig
} from '../utils/utils.js'

/**
 * FindDDO's provider loop.
 *
 * It used to query providers one at a time with a fixed five-second pause after each, inside a
 * loop that could re-run the whole pass. At the provider maximum of five that is
 * 5 x (one whole sendTo setup budget + 5s) = 250 seconds of structure before the response-body
 * read is counted - and the only reason a request did not take that long was the overall
 * deadline cutting it short, which meant the providers later in the list were simply never
 * asked. So the sequential shape cost latency *and* silently reduced how many providers were
 * consulted.
 *
 * What is asserted here is therefore not just "it is faster": it is that every provider is
 * asked, that each is asked exactly once, that they are asked at the same time, that one slow
 * provider cannot hold the request, and that the answer that ends the search is a *legitimate*
 * one rather than merely an HTTP 200.
 */

const CHAIN_ID = 137
const NFT_ADDRESS = '0x1111111111111111111111111111111111111111'
const DDO_ID = generateDDOHash(NFT_ADDRESS, CHAIN_ID)
const TX_ID = '0x' + 'ab'.repeat(32)
const METADATA_CREATED_TOPIC =
  '0x5463569dcc320958360074a9ab27e809e8a6942c394fb151d139b5f7b4ecb1bd'

/** A DDO whose id is the real sha256(nftAddress + chainId), so the hash gate passes. */
const legitimateDdo = (): any => ({
  id: DDO_ID,
  nftAddress: NFT_ADDRESS,
  chainId: CHAIN_ID,
  version: '4.1.0',
  metadata: { updated: '2026-01-01T00:00:00Z', created: '2026-01-01T00:00:00Z' },
  indexedMetadata: { event: { block: 100, txid: TX_ID, tx: TX_ID } }
})

/** Same shape, but the id does not hash to (nftAddress, chainId) - the first gate rejects it. */
const forgedDdo = (): any => ({
  ...legitimateDdo(),
  id: 'did:op:' + '0'.repeat(64)
})

interface Query {
  peer: string
  at: number
  addrs?: string[]
  signal?: AbortSignal
}

interface ProviderBehaviour {
  /** Milliseconds before the response is produced. */
  delayMs?: number
  /** The DDO body to answer with; omitted means a non-200. */
  body?: any
  multiaddrs?: string[]
}

let queries: Query[]

function buildNode(
  providers: Record<string, ProviderBehaviour>,
  options: { localDdo?: any } = {}
): OceanNode {
  const provider = {
    getBlockNumber: () => Promise.resolve(1_000_000),
    getTransactionReceipt: () =>
      Promise.resolve({ logs: [{ topics: [METADATA_CREATED_TOPIC] }] })
  }
  // ethers only needs a runner that can perform a call for a view function. `erc721List`
  // returns the address it was asked about, which is what "deployed by our factory" means.
  const signer: any = {
    provider,
    call: () =>
      Promise.resolve(
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [NFT_ADDRESS])
      )
  }

  const ddoCache = { updated: 0, dht: new Map<string, any>() }

  const p2pNode: any = {
    getPeerId: () => 'self-peer',
    getDDOCache: () => ddoCache,
    getProvidersForString: () =>
      Promise.resolve(
        Object.keys(providers).map((peer) => ({
          id: peer,
          multiaddrs: providers[peer].multiaddrs ?? []
        }))
      ),
    sendTo: async (
      peer: string,
      unusedMessage: string,
      addrs?: string[],
      unusedBody?: unknown,
      signal?: AbortSignal
    ) => {
      queries.push({ peer, at: Date.now(), addrs, signal })
      const behaviour = providers[peer]
      if (behaviour.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, behaviour.delayMs)
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(signal.reason ?? new Error('aborted'))
            },
            { once: true }
          )
        })
      }
      signal?.throwIfAborted()
      if (!behaviour.body) {
        return { status: { httpStatus: 404, error: 'not found' } }
      }
      return {
        status: { httpStatus: 200 },
        stream: Readable.from([Buffer.from(JSON.stringify(behaviour.body))])
      }
    },
    storeAndAdvertiseDDOS: () => Promise.resolve(true)
  }

  return {
    getConfig: () => ({
      hasP2P: true,
      hasIndexer: false,
      rateLimit: 1_000_000,
      supportedNetworks: { [String(CHAIN_ID)]: { chainId: CHAIN_ID, rpc: 'http://x' } }
    }),
    getRequestMap: () => new Map(),
    hasP2PInterface: () => true,
    getP2PNode: () => p2pNode,
    getBlockchain: () => ({
      getSigner: () => Promise.resolve(signer),
      getProvider: () => Promise.resolve(provider)
    }),
    getKeyManager: () => ({ getPeerId: () => ({ toString: () => 'self-peer' }) }),
    getDatabase: () =>
      Promise.resolve({
        ddo: {
          retrieve: (id: string) =>
            Promise.resolve(options.localDdo && id === DDO_ID ? options.localDdo : null)
        }
      })
  } as unknown as OceanNode
}

const findDdo = async (node: OceanNode): Promise<any[]> => {
  const response = await new FindDdoHandler(node).handle({
    command: PROTOCOL_COMMANDS.FIND_DDO,
    id: DDO_ID
  } as any)
  expect(response.status.httpStatus).to.equal(200)
  let text = ''
  for await (const chunk of response.stream as Readable) {
    text += chunk.toString()
  }
  return JSON.parse(text)
}

describe('FindDDO queries providers concurrently', () => {
  beforeEach(() => {
    queries = []
    resetDdoNotFoundCache()
  })

  it('asks every provider, each exactly once, at the same time', async () => {
    // Five providers that all answer nothing useful, so nothing short-circuits the loop and
    // every branch is observable.
    const providers: Record<string, ProviderBehaviour> = {}
    for (let i = 0; i < 5; i++) {
      providers[`provider-${i}`] = {}
    }

    const started = Date.now()
    await findDdo(buildNode(providers))
    const elapsed = Date.now() - started

    expect(queries.length, 'each provider must be asked exactly once').to.equal(5)
    expect(new Set(queries.map((q) => q.peer)).size).to.equal(5)
    // The old shape paused five seconds after each provider. Even one such pause would put
    // this past a second.
    expect(elapsed, 'nothing may sleep between providers').to.be.below(1_000)
    const spread =
      Math.max(...queries.map((q) => q.at)) - Math.min(...queries.map((q) => q.at))
    expect(spread, 'the queries must overlap, not follow each other').to.be.below(500)
  })

  it('does not re-query a provider that already answered nothing', async () => {
    // The `do/while` re-query pass could ask the same providers the same question again.
    await findDdo(buildNode({ a: {}, b: {} }))
    expect(queries.map((q) => q.peer).sort()).to.deep.equal(['a', 'b'])
  })

  it('passes the addresses on the provider record through, skipping re-resolution', async () => {
    const addrs = ['/ip4/198.51.100.9/tcp/9000']
    await findDdo(buildNode({ a: { multiaddrs: addrs } }))
    expect(queries[0].addrs).to.deep.equal(addrs)
  })

  it('falls back to resolution when the provider record carries no address', async () => {
    await findDdo(buildNode({ a: { multiaddrs: [] } }))
    expect(queries[0].addrs).to.equal(undefined)
  })

  describe('abandons a provider that exceeds its own budget', () => {
    // The budget is lowered for the case rather than waiting out the real one, which also shows
    // the override reaching the code that consumes it.
    let envOverrides: OverrideEnvConfig[]
    before(async () => {
      envOverrides = await setupEnvironment(
        null,
        buildEnvOverrideConfig(
          [ENVIRONMENT_VARIABLES.P2P_FINDDDO_PROVIDER_TIMEOUT_MS],
          ['300']
        )
      )
    })
    after(async () => {
      await tearDownEnvironment(envOverrides)
    })

    it('does not fail the request', async () => {
      const perProvider = P2P_TIMEOUTS.findDdoProviderMs
      expect(perProvider).to.equal(300)
      const slow = { delayMs: 60_000 }
      const started = Date.now()
      const results = await findDdo(buildNode({ slow, alsoSlow: slow }))
      const elapsed = Date.now() - started

      expect(results).to.deep.equal([])
      // The per-provider budget, not the overall FindDDO deadline, is what bounds this.
      expect(elapsed).to.be.below(perProvider + 2_000)
      expect(elapsed).to.be.below(P2P_TIMEOUTS.findDdoMs)
    })
  })
})

describe('FindDDO stops at the first legitimate answer', () => {
  beforeEach(() => {
    queries = []
    resetDdoNotFoundCache()
  })

  it('cancels the remaining providers once one answers legitimately', async () => {
    const results = await findDdo(
      buildNode({
        fast: { body: legitimateDdo() },
        slow: { delayMs: 5_000 },
        alsoSlow: { delayMs: 5_000 }
      })
    )

    expect(results.length, 'the legitimate answer must be in the result').to.equal(1)
    expect(results[0].id).to.equal(DDO_ID)
    expect(queries.length, 'every provider is still asked - they race').to.equal(3)
    for (const query of queries) {
      if (query.peer !== 'fast') {
        expect(
          query.signal?.aborted,
          'a provider still in flight must be cancelled once we have an answer'
        ).to.equal(true)
      }
    }
  })

  it('does not let an HTTP 200 that fails verification cancel the others', async () => {
    // "First legitimate response wins" - a peer that answers 200 with something that does not
    // verify has not answered the question, and must not silence the peers that still might.
    const results = await findDdo(
      buildNode({
        forger: { body: forgedDdo() },
        honest: { delayMs: 100, body: legitimateDdo() }
      })
    )

    expect(results.length).to.equal(1)
    expect(results[0].provider).to.equal('honest')
  })
})

describe('FindDDO remembers a DDO that was found nowhere', () => {
  beforeEach(() => {
    queries = []
    resetDdoNotFoundCache()
  })

  it('skips the provider search on a repeat request for the same missing id', async () => {
    const node = buildNode({ a: {}, b: {} })
    expect(await findDdo(node)).to.deep.equal([])
    expect(queries.length).to.equal(2)

    expect(await findDdo(node)).to.deep.equal([])
    expect(queries.length, 'the second request must not walk providers again').to.equal(2)
  })

  it('never masks a DDO this node holds locally', async () => {
    // The entry is consulted after the local lookup, so a DDO that arrives locally is returned
    // even while a "found nowhere" answer is still remembered.
    const missing = buildNode({ a: {} })
    expect(await findDdo(missing)).to.deep.equal([])

    const local = {
      id: DDO_ID,
      event: { tx: TX_ID },
      metadata: { updated: '2026-02-02T00:00:00Z' }
    }
    const withLocal = buildNode({ a: {} }, { localDdo: local })
    const results = await findDdo(withLocal)
    expect(results.length, 'a locally held DDO must always be returned').to.equal(1)
    expect(results[0].id).to.equal(DDO_ID)
  })
})
