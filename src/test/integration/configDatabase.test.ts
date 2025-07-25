import { Database } from '../../components/database/index.js'
import { expect, assert } from 'chai'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { getMockSupportedNetworks } from '../utils/utils.js'
import { SQLLiteConfigDatabase } from '../../components/database/SQLLiteConfigDatabase.js'
import { DB_TYPES } from '../../utils/constants.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'

const versionConfig: OceanNodeDBConfig = {
  url: 'http://localhost:8108/test-version?apiKey=xyz',
  dbType: DB_TYPES.TYPESENSE
}

const emptyDBConfig: OceanNodeDBConfig = {
  url: '',
  dbType: null
}

describe('Config Database', () => {
  let database: Database
  let oceanIndexer: OceanIndexer
  let initialVersionNull: any

  before(async () => {
    database = await Database.init(versionConfig)

    it('should have null version initially', async () => {
      initialVersionNull = await oceanIndexer.getDatabase().sqliteConfig.retrieveValue()
      assert(initialVersionNull.value === null, 'Initial version should be null')
    })

    oceanIndexer = new OceanIndexer(database, getMockSupportedNetworks())
  })

  it('check version DB instance of SQL Lite', () => {
    expect(database.sqliteConfig).to.be.instanceOf(SQLLiteConfigDatabase)
  })

  it('should set and retrieve version', async () => {
    // Set a specific test version
    const testVersion = '0.9.9'
    await oceanIndexer
      .getDatabase()
      .sqliteConfig.createOrUpdateConfig('version', testVersion)

    // Verify we can retrieve it
    const version = await oceanIndexer.getDatabase().sqliteConfig.retrieveValue()
    assert(version.value === testVersion, `Version should be ${testVersion}`)
  })

  it('should update version and retrieve latest', async () => {
    const initialVersion = '0.2.2'
    const updatedVersion = '0.2.3'

    // Set initial version
    await oceanIndexer
      .getDatabase()
      .sqliteConfig.createOrUpdateConfig('version', initialVersion)
    let version = await oceanIndexer.getDatabase().sqliteConfig.retrieveValue()
    assert(version.value === initialVersion, `Version should be ${initialVersion}`)

    // Update to new version
    await oceanIndexer
      .getDatabase()
      .sqliteConfig.createOrUpdateConfig('version', updatedVersion)
    version = await oceanIndexer.getDatabase().sqliteConfig.retrieveValue()
    assert(version.value === updatedVersion, `Version should be ${updatedVersion}`)
  })
  after(() => {
    oceanIndexer.stopAllThreads()
  })
})

describe('VersionDatabase CRUD (without Elastic or Typesense config)', () => {
  let database: Database

  before(async () => {
    database = await Database.init(emptyDBConfig)
  })

  it('check version DB instance of SQL Lite', () => {
    expect(database.sqliteConfig).to.be.instanceOf(SQLLiteConfigDatabase)
  })

  it('create version', async () => {
    const result = await database.sqliteConfig.createOrUpdateConfig('version', '0.1.0')
    expect(result?.value).to.equal('0.1.0')
  })

  it('retrieve latest version', async () => {
    const result = await database.sqliteConfig.retrieveValue('version')
    expect(result?.value).to.equal('0.1.0')
  })
})
