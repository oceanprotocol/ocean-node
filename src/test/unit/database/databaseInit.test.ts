import { expect } from 'chai'
import sinon from 'sinon'
import { Database } from '../../../components/database/index.js'
import { DatabaseFactory } from '../../../components/database/DatabaseFactory.js'
import {
  createElasticsearchClientWithRetry,
  getOrNull
} from '../../../components/database/ElasticsearchConfigHelper.js'
import { getConfiguration } from '../../../utils/config.js'
import { describeOnElasticsearch } from '../../utils/utils.js'

describe('Database.init', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('returns null when a store fails to initialize', async () => {
    const config = await getConfiguration()
    sinon.stub(DatabaseFactory, 'createStores').rejects(new Error('nonce store down'))
    expect(await Database.init(config.dbConfig)).to.be.equal(null)
  })

  it('returns null for a database type that has no stores', async () => {
    sinon.stub(DatabaseFactory, 'createStores').throws(new Error('no such database'))
    expect(await Database.init({ dbType: 'sqlite' })).to.be.equal(null)
  })

  it('exposes the stores that the factory builds', async () => {
    const stores: any = { nonce: {}, c2d: {} }
    sinon.stub(DatabaseFactory, 'createStores').resolves(stores)
    const database = await Database.init({ dbType: 'sqlite' })
    expect(database.nonce).to.be.equal(stores.nonce)
    expect(database.c2d).to.be.equal(stores.c2d)
    expect(database.getConfig()).to.deep.equal({ dbType: 'sqlite' })
  })
})

describeOnElasticsearch('getOrNull', () => {
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
