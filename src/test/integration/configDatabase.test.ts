import { Database } from '../../components/database/index.js'
import { expect, assert } from 'chai'
import { getConfiguration } from '../../utils/index.js'

// The config store only: no indexer runs here. A stop during the start of an indexer does
// not cancel the start, so an indexer started here would keep running into the next suite.
describe('**********         Config Database', () => {
  let database: Database

  before(async () => {
    database = await Database.init((await getConfiguration()).dbConfig)
  })

  const TEST_CONFIG_KEY = 'test-config-version'

  it('should return { value: null } for an absent key', async () => {
    // a new key on each run: a database server keeps the keys of the earlier runs
    const version = await database.config.retrieveValue(`test-absent-${Date.now()}`)
    assert(version !== null, 'An absent key is not a DB error')
    assert(version.value === null, 'An absent key should have a null value')
  })

  it('create and retrieve version', async () => {
    const created = await database.config.createOrUpdateConfig(TEST_CONFIG_KEY, '0.1.0')
    expect(created).to.deep.equal({ key: TEST_CONFIG_KEY, value: '0.1.0' })
    const result = await database.config.retrieveValue(TEST_CONFIG_KEY)
    expect(result?.value).to.equal('0.1.0')
  })

  it('should update version and retrieve latest', async () => {
    await database.config.createOrUpdateConfig(TEST_CONFIG_KEY, '0.2.2')
    expect((await database.config.retrieveValue(TEST_CONFIG_KEY)).value).to.equal('0.2.2')
    await database.config.createOrUpdateConfig(TEST_CONFIG_KEY, '0.2.3')
    expect((await database.config.retrieveValue(TEST_CONFIG_KEY)).value).to.equal('0.2.3')
  })
})
