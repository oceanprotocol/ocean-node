/**
 * Integration test for the credentials functionality.
 *
 * There are 3 consumers:
 * - The first consumer has access to the asset and to the service
 * - The second consumer has access to the asset but not to the service
 * - The third consumer does not have access to the asset
 *
 * The test performs the following steps:
 * 1. Setup the environment and configuration.
 * 2. Publish a dataset with credentials.
 * 3. Fetch the published DDO.
 * 4. Start an order for all consumers.
 * 5. Try to Download the asset by all consumers.
 */
import { expect, assert } from 'chai'
import { JsonRpcProvider, Signer, ethers, Contract } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { streamToObject } from '../../utils/util.js'
import { expectedTimeoutFailure, waitToIndex } from './testUtils.js'

import {
  Blockchain,
  ENVIRONMENT_VARIABLES,
  EVENTS,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { DownloadHandler } from '../../components/core/handler/downloadHandler.js'
import { GetDdoHandler } from '../../components/core/handler/ddoHandler.js'

import { Readable } from 'stream'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import { publishAsset, orderAsset } from '../utils/assets.js'
import { downloadAssetWithCredentials } from '../data/assets.js'
import { ganachePrivateKeys } from '../utils/addresses.js'
import { homedir } from 'os'
import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' assert { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }

/**
 * Returns a contract instance for the given address
 * @param {string} address - The address of the contract
 * @param {AbiItem[]} [abi] - The ABI of the contract
 * @returns {Contract} - The contract instance
 */
export function getContract(address: string, abi: any, signer: Signer): Contract {
  const contract = new ethers.Contract(address, abi, signer)
  return contract
}

export function getEventFromTx(txReceipt: { logs: any[] }, eventName: string) {
  return txReceipt?.logs?.filter((log) => {
    return log.fragment?.name === eventName
  })[0]
}
/**
 * Create new Access List Contract
 * @param {Signer} signer The signer of the transaction.
 * @param {string} contractFactoryAddress The AccessListFactory address.
 * @param {any} contractFactoryAbi The AccessListFactory ABI.
 * @param {string} nameAccessList The name for access list.
 * @param {string} symbolAccessList The symbol for access list.
 * @param {boolean} transferable Default false, to be soulbound.
 * @param {string} owner Owner of the access list.
 * @param {string[]} user Users of the access lists as addresses.
 * @param {string[]} tokenURI Token URIs list.
 * @return {Promise<string| null>} The transaction hash or null if no transaction
 */
export async function deployAccessListContract(
  signer: Signer,
  contractFactoryAddress: string,
  contractFactoryAbi: any,
  nameAccessList: string,
  symbolAccessList: string,
  transferable: boolean = false,
  owner: string,
  user: string[],
  tokenURI: string[]
): Promise<string | null> {
  if (!nameAccessList || !symbolAccessList) {
    throw new Error(`Access list symbol and name are required`)
  }

  const contract = getContract(contractFactoryAddress, contractFactoryAbi, signer)

  try {
    const tx = await contract.deployAccessListContract(
      nameAccessList,
      symbolAccessList,
      transferable,
      owner,
      user,
      tokenURI
    )

    if (!tx) {
      const e = 'Tx for deploying new access list was not processed on chain.'
      console.error(e)
      throw e
    }
    const trxReceipt = await tx.wait(1)
    const events = getEventFromTx(trxReceipt, 'NewAccessList')
    return events.args[0]
  } catch (e) {
    console.error(`Creation of AccessList failed: ${e}`)
    return null
  }
}
describe('Should run a complete node flow.', () => {
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let provider: JsonRpcProvider

  let publisherAccount: Signer
  let consumerAccounts: Signer[]
  let consumerAddresses: string[]

  let ddo: any
  let did: string
  const orderTxIds: string[] = []

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

  let blockchain: Blockchain
  let contractAcessList: Contract
  let signer: Signer

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
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    const database = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(database)
    const indexer = new OceanIndexer(database, config.indexingNetworks)
    oceanNode.addIndexer(indexer)

    const rpcs: RPCS = config.supportedNetworks
    const chain: SupportedNetwork = rpcs[String(DEVELOPMENT_CHAIN_ID)]
    blockchain = new Blockchain(
      chain.rpc,
      chain.network,
      chain.chainId,
      chain.fallbackRPCs
    )

    provider = new JsonRpcProvider('http://127.0.0.1:8545')

    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccounts = [
      (await provider.getSigner(1)) as Signer,
      (await provider.getSigner(2)) as Signer,
      (await provider.getSigner(3)) as Signer
    ]
    consumerAddresses = await Promise.all(consumerAccounts.map((a) => a.getAddress()))
  })

  it('should deploy accessList contract', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    let networkArtifacts = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!networkArtifacts) {
      networkArtifacts = getOceanArtifactsAdresses().development
    }

    signer = blockchain.getSigner()
    const txAddress = await deployAccessListContract(
      signer,
      networkArtifacts.AccessListFactory,
      AccessListFactory.abi,
      'AllowList',
      'ALLOW',
      false,
      await signer.getAddress(),
      [await signer.getAddress()],
      ['https://oceanprotocol.com/nft/']
    )

    contractAcessList = getContract(txAddress, AccessList.abi, signer)
    const balance = await contractAcessList.balanceOf(await signer.getAddress())
    expect(Number(balance)).to.equal(1)
  })

  it('should have balance from accessList contract', async function () {
    const balance = await contractAcessList.balanceOf(await signer.getAddress())
    expect(Number(balance)).to.equal(1)
  })

  it('should publish download datasets', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const publishedDataset = await publishAsset(
      downloadAssetWithCredentials,
      publisherAccount
    )

    did = publishedDataset.ddo.id
    const { ddo, wasTimeout } = await waitToIndex(
      did,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 3
    )
    if (!ddo) {
      assert(wasTimeout === true, 'published failed due to timeout!')
    }
  })

  it('should fetch the published ddo', async () => {
    const getDDOTask = {
      command: PROTOCOL_COMMANDS.GET_DDO,
      id: did
    }
    const response = await new GetDdoHandler(oceanNode).handle(getDDOTask)
    ddo = await streamToObject(response.stream as Readable)
    assert(ddo.id === did, 'DDO id not matching')
  })

  it('should start an order for all consumers', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    for (let i = 0; i < 3; i++) {
      const orderTxReceipt = await orderAsset(
        ddo,
        0,
        consumerAccounts[i],
        consumerAddresses[i],
        publisherAccount,
        oceanNode
      )
      assert(orderTxReceipt, `order transaction for consumer ${i} failed`)
      const txHash = orderTxReceipt.hash
      assert(txHash, `transaction id not found for consumer ${i}`)
      orderTxIds.push(txHash)
    }
  })

  it('should download file for first consumer', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const doCheck = async () => {
      const consumerAddress = consumerAddresses[0]
      const consumerPrivateKey = ganachePrivateKeys[consumerAddress]
      const transferTxId = orderTxIds[0]

      const wallet = new ethers.Wallet(consumerPrivateKey)
      const nonce = Math.floor(Date.now() / 1000).toString()
      const message = String(ddo.id + nonce)
      const consumerMessage = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )
      const messageHashBytes = ethers.toBeArray(consumerMessage)
      const signature = await wallet.signMessage(messageHashBytes)

      const downloadTask = {
        fileIndex: 0,
        documentId: did,
        serviceId: ddo.services[0].id,
        transferTxId,
        nonce,
        consumerAddress,
        signature,
        command: PROTOCOL_COMMANDS.DOWNLOAD
      }
      const response = await new DownloadHandler(oceanNode).handle(downloadTask)
      assert(response)
      assert(response.stream, 'stream not present')
      assert(response.status.httpStatus === 200, 'http status not 200')
      expect(response.stream).to.be.instanceOf(Readable)
    }

    setTimeout(() => {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(true)
    }, DEFAULT_TEST_TIMEOUT * 3)

    await doCheck()
  })

  it('should not allow to download the asset for second consumer - service level credentials', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const doCheck = async () => {
      const consumerAddress = consumerAddresses[1]
      const consumerPrivateKey = ganachePrivateKeys[consumerAddress]
      const transferTxId = orderTxIds[1]

      const wallet = new ethers.Wallet(consumerPrivateKey)
      const nonce = Math.floor(Date.now() / 1000).toString()
      const message = String(ddo.id + nonce)
      const consumerMessage = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )
      const messageHashBytes = ethers.toBeArray(consumerMessage)
      const signature = await wallet.signMessage(messageHashBytes)

      const downloadTask = {
        fileIndex: 0,
        documentId: did,
        serviceId: ddo.services[0].id,
        transferTxId,
        nonce,
        consumerAddress,
        signature,
        command: PROTOCOL_COMMANDS.DOWNLOAD
      }
      const response = await new DownloadHandler(oceanNode).handle(downloadTask)
      assert(response)
      assert(response.stream === null, 'stream is present')
      assert(response.status.httpStatus === 403, 'http status not 403')
    }

    setTimeout(() => {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(true)
    }, DEFAULT_TEST_TIMEOUT * 3)

    await doCheck()
  })

  it('should not allow to download the asset for third consumer - asset level credentials', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const doCheck = async () => {
      const consumerAddress = consumerAddresses[2]
      const consumerPrivateKey = ganachePrivateKeys[consumerAddress]
      const transferTxId = orderTxIds[1]

      const wallet = new ethers.Wallet(consumerPrivateKey)
      const nonce = Math.floor(Date.now() / 1000).toString()
      const message = String(ddo.id + nonce)
      const consumerMessage = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )
      const messageHashBytes = ethers.toBeArray(consumerMessage)
      const signature = await wallet.signMessage(messageHashBytes)

      const downloadTask = {
        fileIndex: 0,
        documentId: did,
        serviceId: ddo.services[0].id,
        transferTxId,
        nonce,
        consumerAddress,
        signature,
        command: PROTOCOL_COMMANDS.DOWNLOAD
      }
      const response = await new DownloadHandler(oceanNode).handle(downloadTask)
      assert(response)
      assert(response.stream === null, 'stream is present')
      assert(response.status.httpStatus === 403, 'http status not 403')
    }

    setTimeout(() => {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(true)
    }, DEFAULT_TEST_TIMEOUT * 3)

    await doCheck()
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    oceanNode.getIndexer().stopAllThreads()
  })
})
