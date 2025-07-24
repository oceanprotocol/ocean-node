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
import { streamToObject } from '../../utils/util.js'
import { expectedTimeoutFailure, waitToIndex } from './testUtils.js'

import {
  Blockchain,
  ENVIRONMENT_VARIABLES,
  EVENTS,
  PROTOCOL_COMMANDS,
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
import {
  algoAsset,
  computeAssetWithCredentials,
  downloadAssetWithCredentials
} from '../data/assets.js'
import { ganachePrivateKeys } from '../utils/addresses.js'
import { homedir } from 'os'
import AccessListFactory from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessListFactory.sol/AccessListFactory.json' assert { type: 'json' }
import AccessList from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' assert { type: 'json' }
import { deployAccessListContract, getContract } from '../utils/contracts.js'
import { ComputeInitializeHandler } from '../../components/core/compute/initialize.js'
import { ComputeAlgorithm, ComputeAsset } from '../../@types/index.js'
import { ComputeGetEnvironmentsHandler } from '../../components/core/compute/environments.js'
import { ComputeInitializeCommand } from '../../@types/commands.js'

describe('[Credentials Flow] - Should run a complete node flow.', () => {
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let computeEnvironments: any
  let firstEnv: any

  let publisherAccount: Signer
  let consumerAccounts: Signer[]
  let consumerAddresses: string[]

  let ddo: any
  let computeDdo: any
  let algoDdo: any
  let did: string
  let computeDid: string
  let algoDid: string
  const orderTxIds: string[] = []

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]
  let artifactsAddresses: any
  let paymentToken: string

  let blockchain: Blockchain
  let contractAcessList: Contract
  let signer: Signer

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    artifactsAddresses = getOceanArtifactsAdresses()
    paymentToken = artifactsAddresses.development.Ocean

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
          ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS
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
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
          '[{"socketPath":"/var/run/docker.sock","resources":[{"id":"disk","total":1000000000}],"storageExpiry":604800,"maxJobDuration":3600,"fees":{"' +
            DEVELOPMENT_CHAIN_ID +
            '":[{"feeToken":"' +
            paymentToken +
            '","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":60,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1000000000},{"id":"disk","max":1000000000}]}}]'
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    const database = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(config, database)
    const indexer = new OceanIndexer(database, config.indexingNetworks)
    oceanNode.addIndexer(indexer)
    await oceanNode.addC2DEngines()

    const rpcs: RPCS = config.supportedNetworks
    const chain: SupportedNetwork = rpcs[String(DEVELOPMENT_CHAIN_ID)]
    blockchain = new Blockchain(
      chain.rpc,
      chain.network,
      chain.chainId,
      chain.fallbackRPCs
    )

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
    this.timeout(DEFAULT_TEST_TIMEOUT * 5)

    const publishedDataset = await publishAsset(
      downloadAssetWithCredentials,
      publisherAccount
    )

    const publishedComputeDataset = await publishAsset(
      computeAssetWithCredentials,
      publisherAccount
    )

    const publishedAlgo = await publishAsset(algoAsset, publisherAccount)

    did = publishedDataset.ddo.id
    const { ddo, wasTimeout } = await waitToIndex(
      did,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 3
    )
    if (!ddo) {
      assert(wasTimeout === true, 'published failed due to timeout!')
    }

    computeDid = publishedComputeDataset.ddo.id
    const resolvedComputeDdo = await waitToIndex(
      computeDid,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 3
    )
    const ddoCompute = resolvedComputeDdo.ddo
    const timeoutCompute = resolvedComputeDdo.wasTimeout
    if (!ddoCompute) {
      assert(timeoutCompute === true, 'published failed due to timeout!')
    }

    algoDid = publishedAlgo.ddo.id
    const resolvedAlgo = await waitToIndex(
      algoDid,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 3
    )
    const algo = resolvedAlgo.ddo
    const timeoutAlgo = resolvedAlgo.wasTimeout
    if (!algo) {
      assert(timeoutAlgo === true, 'published failed due to timeout!')
    }
  })

  it('should fetch the published ddo', async () => {
    const getDDOTask = {
      command: PROTOCOL_COMMANDS.GET_DDO,
      id: did
    }
    let response = await new GetDdoHandler(oceanNode).handle(getDDOTask)
    ddo = await streamToObject(response.stream as Readable)
    assert(ddo.id === did, 'DDO id not matching')

    const getComputeDDOTask = {
      command: PROTOCOL_COMMANDS.GET_DDO,
      id: computeDid
    }
    response = await new GetDdoHandler(oceanNode).handle(getComputeDDOTask)
    computeDdo = await streamToObject(response.stream as Readable)
    assert(computeDdo.id === computeDid, 'computeDdo id not matching')

    const getAlgoDDOTask = {
      command: PROTOCOL_COMMANDS.GET_DDO,
      id: algoDid
    }
    response = await new GetDdoHandler(oceanNode).handle(getAlgoDDOTask)
    algoDdo = await streamToObject(response.stream as Readable)
    assert(algoDdo.id === algoDid, 'computeDdo id not matching')
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
      const nonce = Date.now().toString()
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

  it('should initializeCompute work for first consumer', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const consumerAddress = consumerAddresses[0]

    const dataset: ComputeAsset = {
      documentId: computeDid,
      serviceId: computeDdo.services[0].id
    }
    const algorithm: ComputeAlgorithm = {
      documentId: algoDid,
      serviceId: algoDdo.services[0].id
    }
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS
    }
    const resp = await new ComputeGetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    computeEnvironments = await streamToObject(resp.stream as Readable)
    firstEnv = computeEnvironments[0]

    const initializeComputeTask: ComputeInitializeCommand = {
      datasets: [dataset],
      algorithm,
      environment: firstEnv.id,
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: 2 * 60,
      consumerAddress,
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE
    }
    const response = await new ComputeInitializeHandler(oceanNode).handle(
      initializeComputeTask
    )
    assert(response)
    assert(response.stream, 'stream not present')
    assert(response.status.httpStatus === 200, 'http status not 200')
    expect(response.stream).to.be.instanceOf(Readable)
  })

  it('should NOT initializeCompute for second consumer - service level credentials', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const consumerAddress = consumerAddresses[1]

    const dataset: ComputeAsset = {
      documentId: computeDid,
      serviceId: computeDdo.services[0].id
    }
    const algorithm: ComputeAlgorithm = {
      documentId: algoDid,
      serviceId: algoDdo.services[0].id
    }
    const initializeComputeTask: ComputeInitializeCommand = {
      datasets: [dataset],
      algorithm,
      environment: firstEnv.id,
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: 2 * 60,
      consumerAddress,
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE
    }
    const response = await new ComputeInitializeHandler(oceanNode).handle(
      initializeComputeTask
    )
    assert(response)
    assert(response.stream === null, 'stream is present')
    assert(response.status.httpStatus === 403, 'http status not 403')
  })

  it('should NOT initializeCompute for third consumer - asset level credentials', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const consumerAddress = consumerAddresses[2]

    const dataset: ComputeAsset = {
      documentId: computeDid,
      serviceId: computeDdo.services[0].id
    }
    const algorithm: ComputeAlgorithm = {
      documentId: algoDid,
      serviceId: algoDdo.services[0].id
    }
    const initializeComputeTask: ComputeInitializeCommand = {
      datasets: [dataset],
      algorithm,
      environment: firstEnv.id,
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: 2 * 60,
      consumerAddress,
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE
    }
    const response = await new ComputeInitializeHandler(oceanNode).handle(
      initializeComputeTask
    )
    assert(response)
    assert(response.stream === null, 'stream is present')
    assert(response.status.httpStatus === 403, 'http status not 403')
  })

  it('should not allow to download the asset for second consumer - service level credentials', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)

    const doCheck = async () => {
      const consumerAddress = consumerAddresses[1]
      const consumerPrivateKey = ganachePrivateKeys[consumerAddress]
      const transferTxId = orderTxIds[1]

      const wallet = new ethers.Wallet(consumerPrivateKey)
      const nonce = Date.now().toString()
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
      const nonce = Date.now().toString()
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
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    // this is not authorized
    const nonAuthorizedAccount = (await provider.getSigner(4)) as Signer
    const authorizedAccount = await publisherAccount.getAddress()

    printCurrentConfig()
    expect(
      config.authorizedPublishers.length === 1 &&
        config.authorizedPublishers[0] === authorizedAccount,
      'Unable to set AUTHORIZED_PUBLISHERS'
    )

    const publishedDataset = await publishAsset(
      downloadAssetWithCredentials,
      nonAuthorizedAccount
    )

    // will timeout
    const { ddo, wasTimeout } = await waitToIndex(
      publishedDataset?.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
    assert(ddo === null && wasTimeout === true, 'DDO should NOT have been indexed')
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    oceanNode.getIndexer().stopAllThreads()
  })
})
