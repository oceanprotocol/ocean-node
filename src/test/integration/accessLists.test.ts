import {
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { Signer } from 'ethers'
import { Blockchain } from '../../utils/blockchain.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { DEVELOPMENT_CHAIN_ID } from '../../utils/address.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { deployAndGetAccessListConfig } from '../utils/contracts.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { homedir } from 'os'
import { getConfiguration, printCurrentConfig } from '../../utils/config.js'
import { EXISTING_ACCESSLISTS } from '../utils/hooks.js'
import { expect } from 'chai'

describe('Should deploy some accessLists before all other tests.', () => {
  let config: OceanNodeConfig
  // let oceanNode: OceanNode
  // let provider: JsonRpcProvider

  // let consumerAccounts: Signer[]

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

  let blockchain: Blockchain
  //   let contractAcessList: Contract
  let owner: Signer

  before(async () => {
    config = await getConfiguration() // Force reload the configuration

    const rpcs: RPCS = config.supportedNetworks
    const chain: SupportedNetwork = rpcs[String(DEVELOPMENT_CHAIN_ID)]
    blockchain = new Blockchain(
      chain.rpc,
      chain.network,
      chain.chainId,
      chain.fallbackRPCs
    )

    owner = blockchain.getSigner()

    // ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST
    const accessList = await deployAndGetAccessListConfig(owner)
    EXISTING_ACCESSLISTS.set(ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.name, [
      accessList
    ])
    // ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST
    EXISTING_ACCESSLISTS.set(ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST.name, [
      accessList
    ])

    // ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST
    EXISTING_ACCESSLISTS.set(ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST.name, [
      accessList
    ])
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
          ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE,
          // ACCESS_LISTS
          ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST,
          ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([8996]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          JSON.stringify([
            await owner.getAddress() // the node
          ]),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
          JSON.stringify(
            EXISTING_ACCESSLISTS.get(
              ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.name
            )
          ),
          JSON.stringify(
            EXISTING_ACCESSLISTS.get(ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST.name)
          ),
          JSON.stringify(
            EXISTING_ACCESSLISTS.get(
              ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST.name
            )
          )
        ]
      )
    )
    printCurrentConfig()
  })

  it('should have some access lists', () => {
    expect(EXISTING_ACCESSLISTS.size > 0, 'Should have at least 1 accessList')
  })
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    // oceanNode.getIndexer().stopAllThreads()
  })
})
