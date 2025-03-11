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

describe('Version Database', () => {
  let database: Database
  let oceanIndexer: OceanIndexer
  let initialVersionNull: any

  before(async () => {
    database = await new Database(versionConfig)
    oceanIndexer = new OceanIndexer(database, getMockSupportedNetworks())
  })

  it('check version DB instance of SQL Lite', () => {
    expect(database.version).to.be.instanceOf(SQLLiteConfigDatabase)
  })

  it('should have null version initially', async () => {
    initialVersionNull = await oceanIndexer.getDatabase().version.retrieveLatestVersion()
    assert(initialVersionNull.version === null, 'Initial version should be null')
  })

  it('should set and retrieve version', async () => {
    // Set a specific test version
    const testVersion = '0.9.9'
    await oceanIndexer.getDatabase().version.create(testVersion)

    // Verify we can retrieve it
    const version = await oceanIndexer.getDatabase().version.retrieveLatestVersion()
    assert(version.version === testVersion, `Version should be ${testVersion}`)
  })

  it('should update version and retrieve latest', async () => {
    const initialVersion = '0.2.2'
    const updatedVersion = '0.2.3'
    const latestVersion = await oceanIndexer.getDatabase().version.retrieveLatestVersion()

    // Set initial version
    await oceanIndexer.getDatabase().version.update(initialVersion, latestVersion.version)
    let version = await oceanIndexer.getDatabase().version.retrieveLatestVersion()
    assert(version.version === initialVersion, `Version should be ${initialVersion}`)

    // Update to new version
    await oceanIndexer.getDatabase().version.update(updatedVersion, initialVersion)
    version = await oceanIndexer.getDatabase().version.retrieveLatestVersion()
    assert(version.version === updatedVersion, `Version should be ${updatedVersion}`)
  })
})

describe('VersionDatabase CRUD (without Elastic or Typesense config)', () => {
  let database: Database

  before(async () => {
    database = await new Database(emptyDBConfig)
  })

  it('check version DB instance of SQL Lite', () => {
    expect(database.version).to.be.instanceOf(SQLLiteConfigDatabase)
  })

  it('create version', async () => {
    const result = await database.version.create('0.1.0')
    expect(result?.id).to.equal(1)
    expect(result?.version).to.equal('0.1.0')
  })

  it('retrieve latest version', async () => {
    const result = await database.version.retrieveLatestVersion()
    expect(result?.version).to.equal('0.1.0')

    const res = await database.version.retrieveById(1)
    expect(res?.id).to.equal(1)
    expect(res?.version).to.equal('0.1.0')
  })

  it('update version', async () => {
    const result = await database.version.update('0.1.1', '0.1.0')
    expect(result?.version).to.equal('0.1.1')
  })

  it('delete nonce', async () => {
    const result = await database.version.delete('0.1.1')
    expect(result?.id).to.equal(1)
    expect(result?.version).to.equal('0.1.1')
  })
})
