import {
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { JsonRpcProvider, Signer } from 'ethers'
import { Blockchain } from '../../utils/blockchain.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { DEVELOPMENT_CHAIN_ID } from '../../utils/address.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { deployAndGetAccessListConfig } from '../utils/contracts.js'
import { AccessListContract, OceanNodeConfig } from '../../@types/OceanNode.js'
import { homedir } from 'os'
import { getConfiguration } from '../../utils/config.js'
import { EXISTING_ACCESSLISTS } from '../utils/hooks.js'
import { assert, expect } from 'chai'
import { findAccessListCredentials } from '../../utils/credentials.js'

describe('Should deploy some accessLists before all other tests.', () => {
  let config: OceanNodeConfig
  // let oceanNode: OceanNode
  let provider: JsonRpcProvider

  // let consumerAccounts: Signer[]

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

  let blockchain: Blockchain
  //   let contractAcessList: Contract
  let owner: Signer

  let wallets: Signer[] = []

  let allAccessListsDefinitions: AccessListContract[] = []

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    config = await getConfiguration() // Force reload the configuration

    wallets = [
      (await provider.getSigner(0)) as Signer,
      (await provider.getSigner(1)) as Signer,
      (await provider.getSigner(2)) as Signer,
      (await provider.getSigner(3)) as Signer
    ]

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
    const accessListPublishers = await deployAndGetAccessListConfig(
      owner,
      provider,
      wallets
    )
    EXISTING_ACCESSLISTS.set(
      ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.name,
      accessListPublishers
    )
    const accessListValidators = await deployAndGetAccessListConfig(
      owner,
      provider,
      wallets
    )
    // ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST
    EXISTING_ACCESSLISTS.set(
      ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST.name,
      accessListValidators
    )

    const accessListDecrypters = await deployAndGetAccessListConfig(
      owner,
      provider,
      wallets
    )
    // ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST
    EXISTING_ACCESSLISTS.set(
      ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST.name,
      accessListDecrypters
    )

    // put them all here
    allAccessListsDefinitions = [
      accessListPublishers,
      accessListValidators,
      accessListDecrypters
    ]

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

    config = await getConfiguration()
  })

  it('should have some access lists', () => {
    expect(EXISTING_ACCESSLISTS.size > 0, 'Should have at least 1 accessList')
  })

  it(`should have ${ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.name} access lists`, () => {
    assert(
      config.authorizedPublishersList !== null,
      `${ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS_LIST.name}  accessList is not defined`
    )
    console.log(config.authorizedPublishersList)
  })

  it(`should have ${ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST.name} access lists`, () => {
    assert(
      config.allowedValidatorsList !== null,
      `${ENVIRONMENT_VARIABLES.ALLOWED_VALIDATORS_LIST.name} accessList is not defined`
    )
    console.log(config.allowedValidatorsList)
  })

  it(`should have ${ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST.name} access lists`, () => {
    assert(
      config.authorizedPublishersList !== null,
      `${ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS_LIST.name}  accessList is not defined`
    )
    console.log(config.authorizedPublishersList)
  })

  it('should check if wallets are on accessList', async function () {
    for (let z = 0; z < allAccessListsDefinitions.length; z++) {
      for (let i = 0; i < wallets.length; i++) {
        const account = await wallets[i].getAddress()
        const accessListAddress = allAccessListsDefinitions[z][DEVELOPMENT_CHAIN_ID][0] // we have only 1 accesslist per config
        expect(
          (await findAccessListCredentials(owner, account, accessListAddress)) === true,
          `Address ${account} has no balance on Access List ${accessListAddress}, so its not Authorized`
        )
      }
    }
  })

  it('should check that wallets are NOT on accessList', async function () {
    for (let z = 0; z < allAccessListsDefinitions.length; z++) {
      for (let i = wallets.length; i < 4; i++) {
        const account = await (await provider.getSigner(i)).getAddress()
        const accessListAddress = allAccessListsDefinitions[z][DEVELOPMENT_CHAIN_ID][0] // we have only 1 accesslist per config
        expect(
          (await findAccessListCredentials(owner, account, accessListAddress)) === true,
          `Address ${account} has no balance on Access List ${accessListAddress}, so its not Authorized`
        )
      }
    }
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    // oceanNode.getIndexer().stopAllThreads()
  })
})
