import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { expect, assert } from 'chai'
import { OceanIndexer } from '../../components/Indexer/index.js'
import {
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'
import { SQLLiteConfigDatabase } from '../../components/database/SQLLiteConfigDatabase.js'
import { DB_TYPES } from '../../utils/constants.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { homedir } from 'os'

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
  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    database = await Database.init(versionConfig)
    // override and save configuration (always before calling getConfig())
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ALLOWED_ADMINS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
        ],
        [
          JSON.stringify(getMockSupportedNetworks()),
          JSON.stringify([8996]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    it('should have null version initially', async () => {
      initialVersionNull = await oceanIndexer.getDatabase().sqliteConfig.retrieveValue()
      assert(initialVersionNull.value === null, 'Initial version should be null')
    })

    const oceanNode = await OceanNode.getInstance(await getConfiguration(true), database)
    oceanIndexer = new OceanIndexer(
      database,
      getMockSupportedNetworks(),
      oceanNode.blockchainRegistry
    )
    oceanNode.addIndexer(oceanIndexer)
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
  after(async () => {
    oceanIndexer.stopAllChainIndexers()
    await tearDownEnvironment(previousConfiguration)
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
