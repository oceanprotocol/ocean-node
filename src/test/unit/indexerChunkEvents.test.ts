import { expect } from 'chai'
import { ethers } from 'ethers'
import { retrieveChunkEvents } from '../../components/Indexer/utils.js'
import { ESCROW_EVENTS, EVENTS, EVENT_HASHES } from '../../utils/constants.js'

// topic0 hashes derived the same way the implementation splits them, so the test tracks
// EVENT_HASHES automatically as events are added.
const escrowTypes = new Set<string>(ESCROW_EVENTS)
const ESCROW_HASHES = Object.entries(EVENT_HASHES)
  .filter(([, v]) => escrowTypes.has(v.type))
  .map(([hash]) => hash)
const NON_ESCROW_HASHES = Object.keys(EVENT_HASHES).filter(
  (hash) => !ESCROW_HASHES.includes(hash)
)
const depositTopic0 = Object.keys(EVENT_HASHES).find(
  (h) => EVENT_HASHES[h].type === EVENTS.ESCROW_DEPOSIT
)
const metadataCreatedTopic0 = Object.keys(EVENT_HASHES).find(
  (h) => EVENT_HASHES[h].type === EVENTS.METADATA_CREATED
)

// Base mainnet, where the Escrow singleton is deployed in the ocean-contracts address file.
const CHAIN_WITH_ESCROW = 8453
const ESCROW_ADDRESS_ON_BASE = '0x09c9a4010E106b9673DcD58AB021a2C84457f323'
// A chainId not present in the address file => getContractAddress('Escrow') returns ''.
const CHAIN_WITHOUT_ESCROW = 999999999

type GetLogsFilter = {
  fromBlock: number
  toBlock: number
  address?: string
  topics: any[]
}

// Minimal provider stub: records every getLogs filter and returns the queued logs for it.
function makeProvider(logsPerCall: ethers.Log[][]): {
  provider: any
  calls: GetLogsFilter[]
} {
  const calls: GetLogsFilter[] = []
  let i = 0
  const provider = {
    getLogs: (filter: GetLogsFilter): Promise<ethers.Log[]> => {
      calls.push(filter)
      return Promise.resolve(logsPerCall[i++] ?? [])
    }
  }
  return { provider, calls }
}

const log = (blockNumber: number, index: number): ethers.Log =>
  ({ blockNumber, index }) as unknown as ethers.Log

describe('retrieveChunkEvents escrow address filtering', () => {
  it('splits into two queries and address-filters escrow events on a chain where Escrow is deployed', async () => {
    const { provider, calls } = makeProvider([[], []])

    await retrieveChunkEvents(null as any, provider, CHAIN_WITH_ESCROW, 100, 50)

    expect(calls.length, 'should issue exactly two getLogs queries').to.equal(2)

    const escrowCall = calls.find((c) => c.address !== undefined)
    const nonEscrowCall = calls.find((c) => c.address === undefined)
    expect(escrowCall, 'one query must carry an address filter').to.not.equal(undefined)
    expect(nonEscrowCall, 'one query must be topic-only').to.not.equal(undefined)

    // escrow query: filtered to the Escrow contract, topics are the escrow signatures only
    expect(escrowCall.address.toLowerCase()).to.equal(
      ESCROW_ADDRESS_ON_BASE.toLowerCase()
    )
    expect(escrowCall.topics[0]).to.have.members(ESCROW_HASHES)
    expect(escrowCall.topics[0]).to.include(depositTopic0)

    // non-escrow query: no address filter, and must NOT include the generic escrow
    // Deposit/Withdraw signatures (the source of the log noise)
    expect(nonEscrowCall.topics[0]).to.have.members(NON_ESCROW_HASHES)
    expect(nonEscrowCall.topics[0]).to.include(metadataCreatedTopic0)
    expect(nonEscrowCall.topics[0]).to.not.include(depositTopic0)

    // both queries cover the same block range
    for (const c of calls) {
      expect(c.fromBlock).to.equal(101)
      expect(c.toBlock).to.equal(150)
    }
  })

  it('issues a single topic-only query when Escrow is not deployed on the chain', async () => {
    const { provider, calls } = makeProvider([[]])

    await retrieveChunkEvents(null as any, provider, CHAIN_WITHOUT_ESCROW, 0, 10)

    expect(calls.length, 'should issue exactly one getLogs query').to.equal(1)
    expect(calls[0].address, 'query must not carry an address filter').to.equal(undefined)
    expect(calls[0].topics[0]).to.have.members(NON_ESCROW_HASHES)
  })

  it('merges results from both queries sorted by (block, log index)', async () => {
    // non-escrow query returns block 150, escrow query returns earlier/interleaved logs
    const { provider } = makeProvider([
      [log(150, 0)],
      [log(120, 2), log(120, 1), log(101, 5)]
    ])

    const result = await retrieveChunkEvents(
      null as any,
      provider,
      CHAIN_WITH_ESCROW,
      100,
      50
    )

    const order = result.map((l) => [l.blockNumber, l.index])
    expect(order).to.deep.equal([
      [101, 5],
      [120, 1],
      [120, 2],
      [150, 0]
    ])
  })
})
