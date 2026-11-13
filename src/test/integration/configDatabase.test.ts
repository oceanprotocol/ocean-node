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
import { ElasticsearchConfigDatabase } from '../../components/database/ElasticsearchConfigDatabase.js'
import { createElasticsearchClientWithRetry } from '../../components/database/ElasticsearchConfigHelper.js'
import { stateSchemas } from '../../components/database/ElasticSchemas.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { homedir } from 'os'

async function wipeConfigIndex(dbConfig: OceanNodeDBConfig): Promise<void> {
  const client = await createElasticsearchClientWithRetry(dbConfig)
  await client.deleteByQuery({
    index: stateSchemas.nodeConfig.index,
    query: { match_all: {} },
    refresh: true,
    conflicts: 'proceed'
  })
}

describe('**********         Config Database', () => {
  let database: Database
  let oceanIndexer: OceanIndexer
  let previousConfiguration: OverrideEnvConfig[]
  let oceanNode: OceanNode

  before(async () => {
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
    const config = await getConfiguration(true)
    database = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(
      config,
      database,
      null,
      null,
      null,
      null,
      null,
      true
    )
    oceanIndexer = new OceanIndexer(database, config, oceanNode.blockchainRegistry)
    oceanNode.addIndexer(oceanIndexer)
  })

  beforeEach(async () => {
    await wipeConfigIndex(database.getConfig())
  })

  after(async () => {
    await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
  })

  it('config DB is the Elasticsearch store', () => {
    expect(database.config).to.be.instanceOf(ElasticsearchConfigDatabase)
  })

  // Use a dedicated config key (not 'version'): the live OceanIndexer started by this suite
  // writes the running node version to the 'version' key in the shared config index during its
  // background reindex (see checkAndTriggerReindexing), which would race these CRUD assertions.
  const TEST_CONFIG_KEY = 'test-config-version'

  it('should return { value: null } for an absent key', async () => {
    const version = await oceanIndexer.getDatabase().config.retrieveValue(TEST_CONFIG_KEY)
    assert(version !== null, 'An absent key is not a DB error')
    assert(version.value === null, 'An absent key should have a null value')
  })

  it('should set and retrieve version', async () => {
    // Set a specific test version
    const testVersion = '0.9.9'
    await oceanIndexer
      .getDatabase()
      .config.createOrUpdateConfig(TEST_CONFIG_KEY, testVersion)

    // Verify we can retrieve it
    const version = await oceanIndexer.getDatabase().config.retrieveValue(TEST_CONFIG_KEY)
    assert(version.value === testVersion, `Version should be ${testVersion}`)
  })

  it('should update version and retrieve latest', async () => {
    const initialVersion = '0.2.2'
    const updatedVersion = '0.2.3'

    // Set initial version
    await oceanIndexer
      .getDatabase()
      .config.createOrUpdateConfig(TEST_CONFIG_KEY, initialVersion)
    let version = await oceanIndexer.getDatabase().config.retrieveValue(TEST_CONFIG_KEY)
    assert(version.value === initialVersion, `Version should be ${initialVersion}`)

    // Update to new version
    await oceanIndexer
      .getDatabase()
      .config.createOrUpdateConfig(TEST_CONFIG_KEY, updatedVersion)
    version = await oceanIndexer.getDatabase().config.retrieveValue(TEST_CONFIG_KEY)
    assert(version.value === updatedVersion, `Version should be ${updatedVersion}`)
  })
})

describe('VersionDatabase CRUD', () => {
  let database: Database

  before(async () => {
    database = await Database.init((await getConfiguration()).dbConfig)
  })

  beforeEach(async () => {
    await wipeConfigIndex(database.getConfig())
  })

  it('config DB is the Elasticsearch store', () => {
    expect(database.config).to.be.instanceOf(ElasticsearchConfigDatabase)
  })

  const TEST_CONFIG_KEY = 'test-crud-version'

  it('create and retrieve version', async () => {
    const created = await database.config.createOrUpdateConfig(TEST_CONFIG_KEY, '0.1.0')
    expect(created).to.deep.equal({ key: TEST_CONFIG_KEY, value: '0.1.0' })
    const result = await database.config.retrieveValue(TEST_CONFIG_KEY)
    expect(result?.value).to.equal('0.1.0')
  })
})
