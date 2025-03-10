import { assert } from 'chai'
import { JsonRpcProvider, ethers } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { homedir } from 'os'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  INDEXER_CRAWLING_EVENT_EMITTER,
  OceanIndexer
} from '../../components/Indexer/index.js'

describe('Should test admin operations', () => {
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let dbconn: Database
  let indexer: OceanIndexer
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')
  const wallet = new ethers.Wallet(
    '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
    provider
  )

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

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
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify([await wallet.getAddress()]),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    await dbconn.version.setNodeVersion('0.1.2') // lower version
    oceanNode = await OceanNode.getInstance(dbconn)
    indexer = new OceanIndexer(dbconn, config.indexingNetworks) // activate reindexing
    oceanNode.addIndexer(indexer)
  })

  it('should update the version', async () => {
    assert(
      (await dbconn.version.getNodeVersion()) === '0.1.2',
      'version not updated with the current one'
    )
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    INDEXER_CRAWLING_EVENT_EMITTER.removeAllListeners()
    indexer.stopAllThreads()
  })
})
