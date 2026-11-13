import { expect } from 'chai'
import sinon from 'sinon'
import { Database } from '../../../components/database/index.js'
import { DatabaseFactory } from '../../../components/database/DatabaseFactory.js'
import {
  createElasticsearchClientWithRetry,
  getOrNull
} from '../../../components/database/ElasticsearchConfigHelper.js'
import { getConfiguration } from '../../../utils/config.js'

describe('Database.init', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('returns null when a store fails to initialize', async () => {
    const config = await getConfiguration()
    sinon
      .stub(DatabaseFactory, 'createNonceDatabase')
      .rejects(new Error('nonce store down'))
    expect(await Database.init(config.dbConfig)).to.be.equal(null)
  })

  it('returns null when the node metrics store fails to initialize', async () => {
    const config = await getConfiguration()
    sinon
      .stub(DatabaseFactory, 'createNodeMetricsDatabase')
      .rejects(new Error('metrics store down'))
    expect(await Database.init(config.dbConfig)).to.be.equal(null)
  })
})

describe('getOrNull', () => {
  it('rejects when the index does not exist', async () => {
    const config = await getConfiguration()
    const client = await createElasticsearchClientWithRetry(config.dbConfig)
    let error: any = null
    try {
      await getOrNull(client, 'ocean_test_index_that_does_not_exist', 'any-id')
    } catch (err) {
      error = err
    }
    expect(error?.meta?.body?.error?.type).to.equal('index_not_found_exception')
  })
})
