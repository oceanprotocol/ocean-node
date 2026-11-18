import { expect } from 'chai'
import sinon from 'sinon'
import { Readable } from 'stream'
import {
  QueryDdoStateHandler,
  QueryHandler
} from '../../components/core/handler/queryHandler.js'
import { UnsupportedQueryError } from '../../components/database/BaseDatabase.js'
import { ElasticsearchDdoDatabase } from '../../components/database/ElasticSearchDatabase.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'

const SCHEMAS = [{ index: 'op_ddo_v4.1.0' }, { index: 'op_ddo_short' }]
const MATCH_ALL = { match_all: {} }

describe('Query handler', () => {
  let ddoSearch: sinon.SinonStub
  let orderSearch: sinon.SinonStub
  let ddoStateSearch: sinon.SinonStub
  let node: any

  beforeEach(() => {
    ddoSearch = sinon.stub().resolves([[{ id: 'did:op:1' }]])
    orderSearch = sinon.stub().resolves([{ id: '0xorder' }])
    ddoStateSearch = sinon.stub().resolves([])
    const database = {
      ddo: { search: ddoSearch, getSchemas: () => SCHEMAS },
      order: { search: orderSearch },
      ddoState: { search: ddoStateSearch }
    }
    node = {
      getRequestMap: () => new Map(),
      getConfig: () => ({ rateLimit: 1000 }),
      getDatabase: () => Promise.resolve(database)
    }
  })

  const run = async (query: Record<string, any>) => {
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

  it('searches all DDOs for a query with no index', async () => {
    const { status, body } = await run({ query: MATCH_ALL, size: 5 })
    expect(status.httpStatus).to.equal(200)
    expect(body).to.deep.equal([[{ id: 'did:op:1' }]])
    expect(ddoSearch.firstCall.args[0]).to.deep.equal({ query: MATCH_ALL, size: 5 })
  })

  it('gives the name of a DDO schema to the DDO store', async () => {
    await run({ index: 'op_ddo_short', query: MATCH_ALL })
    expect(ddoSearch.firstCall.args[0]).to.deep.equal({
      index: 'op_ddo_short',
      query: MATCH_ALL
    })
  })

  it('searches the orders for the index "order", and gives them as one array', async () => {
    const { body } = await run({ index: 'order', query: MATCH_ALL })
    expect(body).to.deep.equal([[{ id: '0xorder' }]])
    expect(orderSearch.firstCall.args[0]).to.deep.equal({ query: MATCH_ALL })
    expect(ddoSearch.called).to.equal(false)
  })

  it('gives no array when no order matches, or when the order search fails', async () => {
    orderSearch.resolves([])
    expect((await run({ index: 'order', query: MATCH_ALL })).body).to.deep.equal([])
    orderSearch.resolves(null)
    expect((await run({ index: 'order', query: MATCH_ALL })).body).to.deep.equal([])
  })

  for (const index of ['c2d_jobs', 'auth_tokens', 'nonce']) {
    it(`searches all DDOs for the index '${index}': no other store is readable`, async () => {
      const { status } = await run({ index, query: MATCH_ALL })
      expect(status.httpStatus).to.equal(200)
      expect(ddoSearch.firstCall.args[0]).to.deep.equal({ query: MATCH_ALL })
      expect(orderSearch.called).to.equal(false)
    })
  }

  it('answers 400 for a lookup into another index: the node state is not readable', async () => {
    const lookup = { index: 'c2d_jobs', id: 'job1', path: 'owner' }
    const queries = [
      { query: { terms: { 'nft.owner': lookup } } },
      { index: 'order', query: { bool: { filter: [{ terms: { consumer: lookup } }] } } },
      { query: { more_like_this: { like: [{ _index: 'nonce', _id: '0xabc' }] } } },
      {
        query: MATCH_ALL,
        runtime_mappings: {
          job: {
            type: 'lookup',
            target_index: 'c2d_jobs',
            input_field: 'id',
            target_field: '_id',
            fetch_fields: ['owner']
          }
        }
      },
      // the same terms lookup, hidden in base64
      {
        index: 'order',
        query: {
          wrapper: {
            query: Buffer.from(JSON.stringify({ terms: { consumer: lookup } })).toString(
              'base64'
            )
          }
        }
      }
    ]
    for (const query of queries) {
      const { status } = await run(query)
      expect(status.httpStatus).to.equal(400)
    }
    expect(ddoSearch.called).to.equal(false)
    expect(orderSearch.called).to.equal(false)
  })

  it('accepts a query on a field named index, target_index or wrapper', async () => {
    for (const field of ['index', 'target_index', 'wrapper']) {
      const { status } = await run({ query: { term: { [field]: 'a' } } })
      expect(status.httpStatus).to.equal(200)
    }
  })

  it('answers 400 for a query clause that the database cannot run', async () => {
    ddoSearch.rejects(new UnsupportedQueryError('wildcard', 'sqlite'))
    const { status } = await run({ query: { wildcard: { id: 'did*' } } })
    expect(status.httpStatus).to.equal(400)
    expect(status.error).to.equal(
      "Query clause 'wildcard' is not supported on the sqlite database"
    )
  })

  it('answers 400 for a page that is past the first 10000 documents', async () => {
    const { status } = await run({ query: MATCH_ALL, size: 100, from: 101 })
    expect(status.httpStatus).to.equal(400)
    expect(ddoSearch.called).to.equal(false)
    expect(
      (await run({ query: MATCH_ALL, size: 100, from: 100 })).status.httpStatus
    ).to.equal(200)
  })

  it('answers 400 for a size that is not a whole number, 0 or more', async () => {
    for (const size of [-1, 'abc', { a: 1 }]) {
      const { status } = await run({ index: 'order', query: MATCH_ALL, size })
      expect(status.httpStatus).to.equal(400)
    }
    expect(orderSearch.called).to.equal(false)
  })

  it('gives the page size 0 to the store: a count-only query reads no document', async () => {
    const { status } = await run({ query: MATCH_ALL, size: 0 })
    expect(status.httpStatus).to.equal(200)
  })

  it('answers 500 for another error', async () => {
    ddoSearch.rejects(new Error('database is down'))
    const { status } = await run({ query: MATCH_ALL })
    expect(status.httpStatus).to.equal(500)
  })

  it('the DDO state query answers 400 for a clause that the database cannot run', async () => {
    ddoStateSearch.rejects(new UnsupportedQueryError('wildcard', 'sqlite'))
    const response = await new QueryDdoStateHandler(node).handle({
      command: PROTOCOL_COMMANDS.QUERY,
      query: { wildcard: { did: 'did*' } }
    })
    expect(response.status.httpStatus).to.equal(400)
  })
})

describe('Elasticsearch DDO search', () => {
  let search: sinon.SinonStub
  let ddoDb: ElasticsearchDdoDatabase

  beforeEach(() => {
    search = sinon.stub().resolves({ hits: { hits: [] } })
    // the constructor only keeps the config; create() would connect to Elasticsearch
    ddoDb = new (ElasticsearchDdoDatabase as any)({ dbType: 'elasticsearch' })
    ;(ddoDb as any).schemas = SCHEMAS
    sinon.stub(ddoDb as any, 'client').resolves({ search })
  })

  afterEach(() => sinon.restore())

  const searchedIndices = () => search.getCalls().map((call) => call.args[0].index)

  it('searches all DDO schemas for a query with no index', async () => {
    await ddoDb.search({ query: MATCH_ALL })
    expect(searchedIndices()).to.deep.equal(['op_ddo_v4.1.0', 'op_ddo_short'])
  })

  it('searches the named DDO schema only', async () => {
    await ddoDb.search({ index: 'op_ddo_short', query: MATCH_ALL })
    expect(searchedIndices()).to.deep.equal(['op_ddo_short'])
  })

  it('never reads an index that is not a DDO index', async () => {
    await ddoDb.search({ index: 'c2d_jobs', query: MATCH_ALL })
    expect(searchedIndices()).to.deep.equal(['op_ddo_v4.1.0', 'op_ddo_short'])
    expect(search.firstCall.args[0].body).to.not.have.property('index')
  })

  it('sends the page number as a document offset', async () => {
    await ddoDb.search({ index: 'op_ddo_short', query: MATCH_ALL, from: 3, size: 20 })
    expect(search.firstCall.args[0].body).to.deep.equal({
      query: MATCH_ALL,
      from: 40,
      size: 20
    })
  })
})
