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
import { JsonRpcProvider, Signer, ethers, Contract, EventLog } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { sleep, streamToObject } from '../../utils/util.js'
import { expectedTimeoutFailure, waitToIndex } from './testUtils.js'

import {
  Blockchain,
  ENVIRONMENT_VARIABLES,
  EVENTS,
  PROTOCOL_COMMANDS,
  UNAUTHORIZED_ACTION_EVENT,
  getConfiguration,
  printCurrentConfig
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
import { deployAccessListContract, getContract } from '../utils/contracts.js'

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
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccounts = [
      (await provider.getSigner(1)) as Signer,
      (await provider.getSigner(2)) as Signer,
      (await provider.getSigner(3)) as Signer
    ]
    consumerAddresses = await Promise.all(consumerAccounts.map((a) => a.getAddress()))

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
            await publisherAccount.getAddress() // signer 0
          ]),
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
    // check if we emited the event and the address is part of the list now
    const account = await signer.getAddress()
    const eventLogs: Array<EventLog> = (await contractAcessList.queryFilter(
      'AddressAdded',
      networkArtifacts.startBlock,
      'latest'
    )) as Array<EventLog>
    // at least 1 event
    expect(eventLogs.length).to.be.at.least(1)
    for (const log of eventLogs) {
      // check the account address
      if (log.args.length === 2 && Number(log.args[1] >= 1)) {
        const address: string = log.args[0]
        expect(address.toLowerCase()).to.be.equal(account.toLowerCase())
      }
    }
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

  it('should NOT allow to index the asset because address is not on AUTHORIZED_PUBLISHERS', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    // this is not authorized
    const nonAuthorizedAccount = (await provider.getSigner(4)) as Signer
    const authorizedAccount = await publisherAccount.getAddress()
    console.log('authorized account: ', authorizedAccount)
    console.log('Unauthorized account: ', await nonAuthorizedAccount.getAddress())

    printCurrentConfig()
    expect(
      config.authorizedPublishers.length === 1 &&
        config.authorizedPublishers[0] === authorizedAccount,
      'Unable to set AUTHORIZED_PUBLISHERS'
    )

    // asset will be published with new Indexer already (actually it will NOT be published)
    const publishedDataset = await publishAsset(
      downloadAssetWithCredentials,
      nonAuthorizedAccount
    )

    did = publishedDataset.ddo.id
    console.log('published asset with did: ', did)
    const { ddo } = await waitToIndex(
      did,
      UNAUTHORIZED_ACTION_EVENT,
      DEFAULT_TEST_TIMEOUT * 3,
      true
    )
    assert(ddo === null, 'DDO should NOT have been indexed')
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    oceanNode.getIndexer().stopAllThreads()
  })
})
