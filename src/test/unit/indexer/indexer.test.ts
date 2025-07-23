import { assert, expect } from 'chai'
import { describe, it } from 'mocha'
import { OceanIndexer } from '../../../components/Indexer/index.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../../utils/index.js'
import { Database } from '../../../components/database/index.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import {
  hasValidDBConfiguration,
  isReachableConnection
} from '../../../utils/database.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../../utils/utils.js'

describe('OceanIndexer', () => {
  let envOverrides: OverrideEnvConfig[]
  let oceanIndexer: OceanIndexer
  let mockDatabase: Database
  let config: OceanNodeConfig
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS],
      [
        '{ "8996":{ "rpc":"http://127.0.0.1:8545", "fallbackRPCs": ["http://127.0.0.3:8545","http://127.0.0.1:8545"], "chainId": 8996, "network": "development", "chunkSize": 100 }}'
      ]
    )
    envOverrides = await setupEnvironment(null, envOverrides)
    config = await getConfiguration(true)
    mockDatabase = await new Database(config.dbConfig)
    console.log('mockDatabase: ', mockDatabase)
    console.log('config.dbConfig: ', JSON.stringify(config.dbConfig))
  })

  it('should start threads and handle worker events', async () => {
    oceanIndexer = new OceanIndexer(mockDatabase, config.supportedNetworks)
    assert(oceanIndexer, 'indexer should not be null')
    console.log('mockDatabase: ', mockDatabase)
    expect(oceanIndexer.getDatabase().getConfig()).to.be.equal(mockDatabase.getConfig())
    expect(oceanIndexer.getIndexingQueue().length).to.be.equal(0)
    expect(oceanIndexer.getJobsPool().length).to.be.equal(0)

    if (
      hasValidDBConfiguration(mockDatabase.getConfig()) &&
      (await isReachableConnection(mockDatabase.getConfig().url))
    ) {
      // should be fine, if we have a valid RPC as well
      expect(await oceanIndexer.startThreads()).to.be.equal(true)
    } else {
      // cannot start threads without DB connection
      expect(await oceanIndexer.startThreads()).to.be.equal(false)
    }

    // there are no worker threads available
    expect(oceanIndexer.stopAllThreads()).to.be.equal(false)
  })
  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
