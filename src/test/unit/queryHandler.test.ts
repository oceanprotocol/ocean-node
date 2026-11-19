import { expect } from 'chai'
import sinon from 'sinon'
import { Readable } from 'stream'
import {
  QueryDdoStateHandler,
  QueryHandler
} from '../../components/core/handler/queryHandler.js'
import { ElasticsearchDdoDatabase } from '../../components/database/ElasticSearchDatabase.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'

const SCHEMAS = [{ index: 'op_ddo_v4.1.0' }, { index: 'op_ddo_v5.0.0' }]
const DDO = { id: 'did:op:1' }

describe('Query handler', () => {
  let ddoFind: sinon.SinonStub
  let ddoTags: sinon.SinonStub
  let orderFind: sinon.SinonStub
  let ddoStateFind: sinon.SinonStub
  let node: any

  beforeEach(() => {
    ddoFind = sinon.stub().resolves({ results: [DDO], totalResults: 7 })
    ddoTags = sinon.stub().resolves([{ tag: 'weather', count: 2 }])
    orderFind = sinon.stub().resolves({ results: [{ id: '0xorder' }], totalResults: 1 })
    ddoStateFind = sinon.stub().resolves([{ id: 'did:op:1' }])
    const database = {
      ddo: { find: ddoFind, tags: ddoTags, getSchemas: () => SCHEMAS },
      order: { find: orderFind },
      ddoState: { find: ddoStateFind }
    }
    node = {
      getRequestMap: () => new Map(),
      getConfig: () => ({ rateLimit: 1000 }),
      getDatabase: () => Promise.resolve(database)
    }
  })

  const run = async (query: unknown) => {
    const response = await new QueryHandler(node).handle({
      command: PROTOCOL_COMMANDS.QUERY,
      query,
      caller: '127.0.0.1'
    })
    const body = response.stream
      ? JSON.parse(await streamToString(response.stream as Readable))
      : undefined
    return { status: response.status, body }
  }

  it('searches the assets: conditions, sort and page; answers results and total', async () => {
    const { status, body } = await run({
      filter: { chainIds: [8996], types: ['dataset'] },
      sort: { by: 'orders', order: 'asc' },
      page: 2,
      size: 5
    })
    expect(status.httpStatus).to.equal(200)
    expect(body).to.deep.equal({ results: [DDO], totalResults: 7 })
    const [conditions, sort, page] = ddoFind.firstCall.args
    expect(conditions).to.deep.include({
      paths: ['chainId', 'credentialSubject.chainId'],
      anyOf: [8996]
    })
    expect(sort).to.deep.equal([
      { paths: ['indexedMetadata.stats.orders'], order: 'asc' }
    ])
    expect(page).to.deep.equal({ offset: 5, limit: 5 })
  })

  it('searches the orders of a consumer', async () => {
    const { body } = await run({ type: 'orders', filter: { consumer: '0xC' }, size: 10 })
    expect(body).to.deep.equal({ results: [{ id: '0xorder' }], totalResults: 1 })
    expect(orderFind.firstCall.args).to.deep.equal([
      { consumer: '0xC' },
      { offset: 0, limit: 10 }
    ])
    expect(ddoFind.called).to.equal(false)
  })

  it('gives the tags of the assets that match', async () => {
    const { body } = await run({ type: 'tags', filter: { chainIds: [1] }, size: 50 })
    expect(body).to.deep.equal({
      results: [{ tag: 'weather', count: 2 }],
      totalResults: 1
    })
    expect(ddoTags.firstCall.args[1]).to.equal(50)
  })

  it('answers 400 for an Elasticsearch body, an unknown filter and a deep page', async () => {
    for (const query of [
      { query: { match_all: {} } },
      { filter: { color: 'red' } },
      { page: 101, size: 100 },
      'not an object'
    ]) {
      const { status } = await run(query)
      expect(status.httpStatus).to.equal(400)
    }
    expect(ddoFind.called).to.equal(false)
  })

  it('answers 500 for another error', async () => {
    ddoFind.rejects(new Error('database is down'))
    const { status } = await run({})
    expect(status.httpStatus).to.equal(500)
  })

  it('the DDO state query gives the key to the store', async () => {
    const response = await new QueryDdoStateHandler(node).handle({
      command: PROTOCOL_COMMANDS.QUERY,
      query: { txId: '0xtx' }
    })
    expect(response.status.httpStatus).to.equal(200)
    expect(ddoStateFind.firstCall.args[0]).to.deep.equal({ txId: '0xtx' })
  })
})

describe('Elasticsearch DDO store: one search over all DDO indices', () => {
  let search: sinon.SinonStub
  let ddoDb: ElasticsearchDdoDatabase

  beforeEach(() => {
    search = sinon.stub().resolves({
      hits: { hits: [{ _id: 'did:op:1', _source: {} }], total: { value: 42 } },
      aggregations: {
        tags0: { buckets: [{ key: 'weather', doc_count: 2 }] },
        tags1: {
          buckets: [
            { key: 'weather', doc_count: 1 },
            { key: 'ml', doc_count: 1 }
          ]
        }
      }
    })
    // the constructor only keeps the config; create() would connect to Elasticsearch
    ddoDb = new (ElasticsearchDdoDatabase as any)({ dbType: 'elasticsearch' })
    sinon.stub(ddoDb as any, 'client').resolves({ search })
  })

  afterEach(() => sinon.restore())

  it('searches the DDO indices only, with the page as a document offset', async () => {
    const found = await ddoDb.find([], [], { offset: 40, limit: 20 })
    expect(found).to.deep.equal({ results: [{ id: 'did:op:1' }], totalResults: 42 })
    const request = search.firstCall.args[0]
    expect(request.index).to.deep.equal(ddoDb.getSchemas().map((s) => s.index))
    expect(request).to.include({ from: 40, size: 20, track_total_hits: true })
    expect(request.query).to.deep.equal({ match_all: {} })
  })

  it('sorts by the key, then by id; an exact value of a dynamic field uses .keyword', async () => {
    await ddoDb.find(
      [{ paths: ['indexedMetadata.nft.owner'], anyOf: ['0xabc'] }],
      [{ paths: ['indexedMetadata.stats.symbol'], order: 'asc' }],
      { offset: 0, limit: 1 }
    )
    const request = search.firstCall.args[0]
    expect(request.sort).to.deep.equal([
      {
        'indexedMetadata.stats.symbol.keyword': {
          order: 'asc',
          missing: '_last',
          unmapped_type: 'keyword'
        }
      },
      { id: { order: 'asc' } }
    ])
    expect(request.query.bool.filter[0]).to.deep.equal({
      terms: { 'indexedMetadata.nft.owner.keyword': ['0xabc'] }
    })
  })

  it('adds the tags of the v4 and v5 fields together', async () => {
    expect(await ddoDb.tags([], 10)).to.deep.equal([
      { tag: 'weather', count: 3 },
      { tag: 'ml', count: 1 }
    ])
  })
})
