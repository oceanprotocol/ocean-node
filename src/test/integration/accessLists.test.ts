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
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { deployAccessListContract, getContract } from '../utils/contracts.js'
import { AccessListContract, OceanNodeConfig } from '../../@types/OceanNode.js'
import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' assert { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { homedir } from 'os'
import { getConfiguration } from '../../utils/config.js'
import { EXISTING_ACCESSLISTS } from '../utils/hooks.js'
import { expect } from 'chai'

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

  async function deployAccessList(
    envVariable: string
  ): Promise<AccessListContract | null> {
    let networkArtifacts = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!networkArtifacts) {
      networkArtifacts = getOceanArtifactsAdresses().development
    }

    const wallets = [
      (await provider.getSigner(0)) as Signer,
      (await provider.getSigner(1)) as Signer,
      (await provider.getSigner(2)) as Signer,
      (await provider.getSigner(3)) as Signer
    ]
    const txAddress = await deployAccessListContract(
      owner, // owner is first account
      networkArtifacts.AccessListFactory,
      AccessListFactory.abi,
      'AllowList',
      'ALLOW',
      false,
      await owner.getAddress(),
      [
        await wallets[0].getAddress(),
        await wallets[1].getAddress(),
        await wallets[2].getAddress(),
        await wallets[3].getAddress()
      ],
      ['https://oceanprotocol.com/nft/']
    )
    console.log('txAddress: ', txAddress)

    const contractAcessList = getContract(txAddress, AccessList.abi, owner)
    console.log('contractAcessList:', contractAcessList)
    return contractAcessList ? { DEVELOPMENT_CHAIN_ID: [txAddress] } : null
  }

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    owner = blockchain.getSigner()

    const list = await deployAccessList(ENVIRONMENT_VARIABLES.AUTHORIZED_PUBLISHERS.name)
    console.log('list is:', list)
    EXISTING_ACCESSLISTS.push(list)

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
          ENVIRONMENT_VARIABLES.ADDRESS_FILE
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
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration

    const rpcs: RPCS = config.supportedNetworks
    const chain: SupportedNetwork = rpcs[String(DEVELOPMENT_CHAIN_ID)]
    blockchain = new Blockchain(
      chain.rpc,
      chain.network,
      chain.chainId,
      chain.fallbackRPCs
    )

    // consumerAccounts = [
    //   (await provider.getSigner(1)) as Signer,
    //   (await provider.getSigner(2)) as Signer,
    //   (await provider.getSigner(3)) as Signer
    // ]
    // consumerAddresses = await Promise.all(consumerAccounts.map((a) => a.getAddress()))
  })

  it('should have some access lists', () => {
    expect(EXISTING_ACCESSLISTS.length > 0, 'Should have at least 1 accessList')
  })
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    // oceanNode.getIndexer().stopAllThreads()
  })
})
