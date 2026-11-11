import { expect } from 'chai'
import sinon from 'sinon'
import { ElasticsearchDdoDatabase } from '../../components/database/ElasticSearchDatabase.js'
import { QueryHandler } from '../../components/core/handler/queryHandler.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'

const SCHEMAS = [{ index: 'op_ddo_v4.1.0' }, { index: 'op_ddo_short' }]

describe('Query index allowlist', () => {
  let search: sinon.SinonStub
  let ddoDb: ElasticsearchDdoDatabase
  let handler: QueryHandler

  beforeEach(() => {
    search = sinon.stub().resolves({ hits: { hits: [] } })
    // skip the async constructor (it connects to Elasticsearch): the test only needs search()
    ddoDb = Object.create(ElasticsearchDdoDatabase.prototype)
    ;(ddoDb as any).schemas = SCHEMAS
    ;(ddoDb as any).client = { search }
    const node: any = {
      getRequestMap: () => new Map(),
      getConfig: () => ({ rateLimit: 1000 }),
      getDatabase: () => Promise.resolve({ ddo: ddoDb })
    }
    handler = new QueryHandler(node)
  })

  const run = (query: Record<string, any>) =>
    handler.handle({ command: PROTOCOL_COMMANDS.QUERY, query, caller: '127.0.0.1' })

  for (const index of ['auth_tokens', 'nonce']) {
    it(`rejects index '${index}' with 400`, async () => {
      const response = await run({ index, query: { match_all: {} } })
      expect(response.status.httpStatus).to.equal(400)
      expect(response.status.error).to.equal(`Index '${index}' is not queryable`)
      expect(search.called).to.equal(false)
    })
  }

  it('searches a DDO schema index', async () => {
    const response = await run({ index: SCHEMAS[0].index, query: { match_all: {} } })
    expect(response.status.httpStatus).to.equal(200)
    expect(search.calledOnce).to.equal(true)
    expect(search.firstCall.args[0].index).to.equal(SCHEMAS[0].index)
  })

  it('searches every DDO schema when no index is given', async () => {
    const response = await run({ query: { match_all: {} } })
    expect(response.status.httpStatus).to.equal(200)
    expect(search.getCalls().map((c) => c.args[0].index)).to.deep.equal(
      SCHEMAS.map((s) => s.index)
    )
  })
})
