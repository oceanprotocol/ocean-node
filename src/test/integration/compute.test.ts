import { expect, assert } from 'chai'
import {
  ComputeGetEnvironmentsHandler,
  // ComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeInitializeHandler,
  FreeComputeStartHandler,
  PaidComputeStartHandler
} from '../../components/core/compute/index.js'
import type {
  PaidComputeStartCommand,
  FreeComputeStartCommand,
  ComputeStopCommand,
  ComputeGetStatusCommand,
  ComputeInitializeCommand
} from '../../@types/commands.js'
import type {
  ComputeAsset,
  ComputeAlgorithm,
  ComputeEnvironment
} from '../../@types/C2D/C2D.js'
import {
  // DB_TYPES,
  ENVIRONMENT_VARIABLES,
  EVENTS,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { Readable } from 'stream'
import { expectedTimeoutFailure, waitToIndex } from './testUtils.js'
import { getEventFromTx, streamToObject } from '../../utils/util.js'
import {
  Contract,
  ethers,
  getAddress,
  hexlify,
  JsonRpcProvider,
  Signer,
  ZeroAddress
} from 'ethers'
import { publishAsset, orderAsset } from '../utils/assets.js'
import { computeAsset, algoAsset } from '../data/assets.js'
import { RPCS } from '../../@types/blockchain.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

import { ProviderFees, ProviderComputeInitializeResults } from '../../@types/Fees.js'
import { homedir } from 'os'
import { publishAlgoDDO, publishDatasetDDO } from '../data/ddo.js'
import { DEVELOPMENT_CHAIN_ID, getOceanArtifactsAdresses } from '../../utils/address.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import OceanToken from '@oceanprotocol/contracts/artifacts/contracts/utils/OceanToken.sol/OceanToken.json' assert { type: 'json' }
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' assert { type: 'json' }
import { createHash } from 'crypto'
import { encrypt } from '../../utils/crypt.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import {
  getAlgoChecksums,
  validateAlgoForDataset
} from '../../components/core/compute/utils.js'

import { freeComputeStartPayload } from '../data/commands.js'
import { DDOManager } from '@oceanprotocol/ddo-js'

describe('Compute', () => {
  let previousConfiguration: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode
  let provider: any
  let publisherAccount: any
  let consumerAccount: any
  let computeEnvironments: any
  let publishedComputeDataset: any
  let publishedAlgoDataset: any
  let jobId: string
  let datasetOrderTxId: any
  let algoOrderTxId: any
  let paymentToken: any
  let paymentTokenContract: any
  let escrowContract: any
  let providerFeesComputeDataset: ProviderFees
  let providerFeesComputeAlgo: ProviderFees
  let indexer: OceanIndexer
  // const now = new Date().getTime() / 1000
  const computeJobDuration = 60 * 15 // 15 minutes from now should be enough
  let firstEnv: ComputeEnvironment

  const wallet = new ethers.Wallet(
    '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
  )
  // const chainId = DEVELOPMENT_CHAIN_ID
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const chainId = DEVELOPMENT_CHAIN_ID
  // randomly use a set of trusted algos or empty arrays
  // should validate if set and match, invalidate otherwise
  const setTrustedAlgosEmpty: boolean = Math.random() <= 0.5

  let publisherAddress: string
  let factoryContract: Contract
  let algoDDO: any
  let datasetDDO: any
  let artifactsAddresses: any
  let initializeResponse: ProviderComputeInitializeResults

  before(async () => {
    artifactsAddresses = getOceanArtifactsAdresses()
    paymentToken = artifactsAddresses.development.Ocean
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE,
          ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([DEVELOPMENT_CHAIN_ID]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
          '[{"socketPath":"/var/run/docker.sock","resources":[{"id":"disk","total":1000000000}],"storageExpiry":604800,"maxJobDuration":3600,"fees":{"' +
            DEVELOPMENT_CHAIN_ID +
            '":[{"feeToken":"' +
            paymentToken +
            '","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":60,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1000000000},{"id":"disk","max":1000000000}]}}]'
        ]
      )
    )
    config = await getConfiguration(true)
    dbconn = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(config, dbconn, null, null, null, true)
    indexer = new OceanIndexer(dbconn, config.indexingNetworks)
    oceanNode.addIndexer(indexer)
    oceanNode.addC2DEngines()

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer

    publisherAddress = await publisherAccount.getAddress()
    algoDDO = { ...publishAlgoDDO }
    datasetDDO = { ...publishDatasetDDO }
    factoryContract = new ethers.Contract(
      artifactsAddresses.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
    paymentTokenContract = new ethers.Contract(
      paymentToken,
      OceanToken.abi,
      publisherAccount
    )
    escrowContract = new ethers.Contract(
      artifactsAddresses.development.Escrow,
      EscrowJson.abi,
      publisherAccount
    )
  })

  it('Sets up compute envs', () => {
    assert(oceanNode, 'Failed to instantiate OceanNode')
    assert(config.c2dClusters, 'Failed to get c2dClusters')
  })

  // let's publish assets & algos
  it('should publish compute datasets & algos', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    publishedComputeDataset = await publishAsset(computeAsset, publisherAccount)
    publishedAlgoDataset = await publishAsset(algoAsset, publisherAccount)
    const computeDatasetResult = await waitToIndex(
      publishedComputeDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
    // consider possible timeouts
    if (!computeDatasetResult.ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(
        computeDatasetResult.wasTimeout
      )
    }
    const algoDatasetResult = await waitToIndex(
      publishedAlgoDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT
    )
    if (!algoDatasetResult.ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(
        algoDatasetResult.wasTimeout
      )
    }
  })

  it('should add the algorithm to the dataset trusted algorithm list', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 5)
    const algoChecksums = await getAlgoChecksums(
      publishedAlgoDataset.ddo.id,
      publishedAlgoDataset.ddo.services[0].id,
      oceanNode
    )
    publishedComputeDataset.ddo.services[0].compute = {
      allowRawAlgorithm: false,
      allowNetworkAccess: true,
      publisherTrustedAlgorithmPublishers: [],
      publisherTrustedAlgorithms: [
        {
          did: publishedAlgoDataset.ddo.id,
          filesChecksum: algoChecksums.files,
          containerSectionChecksum: algoChecksums.container
        }
      ]
    }
    const metadata = hexlify(Buffer.from(JSON.stringify(publishedComputeDataset.ddo)))
    const hash = createHash('sha256').update(metadata).digest('hex')
    const nftContract = new ethers.Contract(
      publishedComputeDataset.ddo.nftAddress,
      ERC721Template.abi,
      publisherAccount
    )
    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x00',
      metadata,
      '0x' + hash,
      []
    )
    const txReceipt = await setMetaDataTx.wait()
    assert(txReceipt, 'set metadata failed')
    publishedComputeDataset = await waitToIndex(
      publishedComputeDataset.ddo.id,
      EVENTS.METADATA_UPDATED,
      DEFAULT_TEST_TIMEOUT * 2,
      true
    )
    assert(
      publishedComputeDataset?.ddo?.services[0]?.compute?.publisherTrustedAlgorithms
        .length > 0,
      'Trusted algorithms not updated'
    )
    assert(
      publishedComputeDataset?.ddo?.services[0]?.compute?.publisherTrustedAlgorithms[0]
        .did === publishedAlgoDataset.ddo.id,
      'Algorithm DID mismatch in trusted algorithms'
    )
  })

  it('Get compute environments', async () => {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS
    }
    const response = await new ComputeGetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    computeEnvironments = await streamToObject(response.stream as Readable)
    console.log('existing envs: ', computeEnvironments)
    // expect 1 OR + envs (1 if only docker free env is available)
    assert(computeEnvironments.length >= 1, 'Not enough compute envs')
    for (const computeEnvironment of computeEnvironments) {
      assert(computeEnvironment.id, 'id missing in computeEnvironments')
      assert(computeEnvironment.fees, 'fees missing in computeEnvironments')
      assert(
        computeEnvironment.consumerAddress,
        'consumerAddress missing in computeEnvironments'
      )

      assert(computeEnvironment.id.startsWith('0x'), 'id should start with 0x')
      assert(computeEnvironment.resources.length > 2, 'Missing resources')
      assert(
        computeEnvironment.maxJobDuration > 0,
        'maxJobDuration missing in computeEnvironments'
      )
    }
    firstEnv = computeEnvironments[0]
  })

  it('Initialize compute without orders transaction IDs', async () => {
    const dataset: ComputeAsset = {
      documentId: publishedComputeDataset.ddo.id,
      serviceId: publishedComputeDataset.ddo.services[0].id
    }
    const algorithm: ComputeAlgorithm = {
      documentId: publishedAlgoDataset.ddo.id,
      serviceId: publishedAlgoDataset.ddo.services[0].id
    }
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS
    }
    const response = await new ComputeGetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    computeEnvironments = await streamToObject(response.stream as Readable)
    firstEnv = computeEnvironments[0]

    const initializeComputeTask: ComputeInitializeCommand = {
      datasets: [dataset],
      algorithm,
      environment: firstEnv.id,
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: computeJobDuration,
      consumerAddress: firstEnv.consumerAddress,
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE
    }
    const resp = await new ComputeInitializeHandler(oceanNode).handle(
      initializeComputeTask
    )
    console.log(resp)
    assert(resp, 'Failed to get response')
    assert(resp.status.httpStatus === 200, 'Failed to get 200 response')
    assert(resp.stream, 'Failed to get stream')
    expect(resp.stream).to.be.instanceOf(Readable)

    const result: any = await streamToObject(resp.stream as Readable)
    console.log(result)
    assert(result.algorithm, 'algorithm does not exist')
    expect(result.algorithm.datatoken?.toLowerCase()).to.be.equal(
      publishedAlgoDataset.datatokenAddress?.toLowerCase()
    )

    providerFeesComputeAlgo = result.algorithm.providerFee

    assert(
      result.algorithm.providerFee.providerFeeAddress,
      'algorithm providerFeeAddress does not exist'
    )
    assert(
      result.algorithm.providerFee.providerFeeToken,
      'algorithm providerFeeToken does not exist'
    )
    assert(
      result.algorithm.providerFee.providerFeeAmount,
      'algorithm providerFeeAmount does not exist'
    )
    assert(
      result.algorithm.providerFee.providerData,
      'algorithm providerFeeData does not exist'
    )

    assert(result.algorithm.providerFee.validUntil, 'algorithm validUntil does not exist')

    assert(result.algorithm.validOrder === false, 'incorrect validOrder') // expect false because tx id was not provided and no start order was called before

    assert(result.datasets.length > 0, 'datasets key does not exist')
    const resultParsed = JSON.parse(JSON.stringify(result.datasets[0]))
    providerFeesComputeDataset = resultParsed.providerFee
    expect(resultParsed.datatoken?.toLowerCase()).to.be.equal(
      publishedComputeDataset.ddo.datatokens[0].address?.toLowerCase()
    )
    assert(
      resultParsed.providerFee.providerFeeAddress,
      'dataset providerFeeAddress does not exist'
    )
    assert(
      resultParsed.providerFee.providerFeeToken,
      'dataset providerFeeToken does not exist'
    )
    assert(
      resultParsed.providerFee.providerFeeAmount,
      'dataset providerFeeAmount does not exist'
    )
    assert(
      resultParsed.providerFee.providerData,
      'dataset providerFeeData does not exist'
    )

    assert(resultParsed.providerFee.validUntil, 'algorithm validUntil does not exist')
    assert(result.datasets[0].validOrder === false, 'incorrect validOrder') // expect false because tx id was not provided and no start order was called before
    assert(result.payment, ' Payment structure does not exists')
    assert(
      result.payment.escrowAddress === artifactsAddresses.development.Escrow,
      'Incorrect escrow address'
    )
    assert(result.payment.payee === firstEnv.consumerAddress, 'Incorrect payee address')
    assert(result.payment.token === paymentToken, 'Incorrect payment token address')
    // TO DO: check result.payment.amount
  })

  it('should start an order on dataset', async function () {
    const orderTxReceipt = await orderAsset(
      publishedComputeDataset.ddo,
      0,
      consumerAccount,
      firstEnv.consumerAddress, // for compute, consumer is always address of compute env
      publisherAccount,
      oceanNode,
      providerFeesComputeDataset
    )
    assert(orderTxReceipt, 'order transaction failed')
    datasetOrderTxId = orderTxReceipt.hash
    assert(datasetOrderTxId, 'transaction id not found')
  })

  it('Initialize compute with dataset tx and without algoritm tx', async () => {
    // now, we have a valid order for dataset, with valid provider fees
    // expected results:
    //  - dataset should have valid order
    //  - dataset should not have providerFee, cause it's already paid & valid
    //  - algo should not have any valid order and it should have providerFee

    const dataset: ComputeAsset = {
      documentId: publishedComputeDataset.ddo.id,
      serviceId: publishedComputeDataset.ddo.services[0].id,
      transferTxId: String(datasetOrderTxId)
    }
    const algorithm: ComputeAlgorithm = {
      documentId: publishedAlgoDataset.ddo.id,
      serviceId: publishedAlgoDataset.ddo.services[0].id
    }
    const initializeComputeTask: ComputeInitializeCommand = {
      datasets: [dataset],
      algorithm,
      environment: firstEnv.id,
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: computeJobDuration,
      consumerAddress: firstEnv.consumerAddress,
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE
    }
    const resp = await new ComputeInitializeHandler(oceanNode).handle(
      initializeComputeTask
    )
    assert(resp, 'Failed to get response')
    assert(resp.status.httpStatus === 200, 'Failed to get 200 response')
    assert(resp.stream, 'Failed to get stream')
    expect(resp.stream).to.be.instanceOf(Readable)

    const result: any = await streamToObject(resp.stream as Readable)
    console.log('446')
    console.log(result)
    console.log('Algo')
    console.log(result.algorithm)
    assert(result.algorithm, 'algorithm does not exist')
    expect(result.algorithm.datatoken?.toLowerCase()).to.be.equal(
      publishedAlgoDataset.datatokenAddress?.toLowerCase()
    )

    assert(
      result.algorithm.providerFee.providerFeeAddress,
      'algorithm providerFeeAddress does not exist'
    )
    assert(
      result.algorithm.providerFee.providerFeeToken,
      'algorithm providerFeeToken does not exist'
    )
    assert(
      result.algorithm.providerFee.providerFeeAmount,
      'algorithm providerFeeAmount does not exist'
    )
    assert(
      result.algorithm.providerFee.providerData,
      'algorithm providerFeeData does not exist'
    )

    assert(result.algorithm.providerFee.validUntil, 'algorithm validUntil does not exist')

    assert(result.algorithm.validOrder === false, 'incorrect validOrder') // expect false because tx id was not provided and no start order was called before

    assert(result.datasets.length > 0, 'datasets key does not exist')
    const resultParsed = JSON.parse(JSON.stringify(result.datasets[0]))
    if ('providerFee' in resultParsed) console.log(resultParsed.providerFee)
    expect(resultParsed.datatoken?.toLowerCase()).to.be.equal(
      publishedComputeDataset.ddo.datatokens[0].address?.toLowerCase()
    )

    assert(
      !('providerFee' in resultParsed),
      'dataset providerFeeAddress should not exist'
    )
    assert(result.datasets[0].validOrder !== false, 'We should have a valid order') // because we started an order earlier
  })

  it('should buy algo', async function () {
    const orderTxReceipt = await orderAsset(
      publishedAlgoDataset.ddo,
      0,
      consumerAccount,
      firstEnv.consumerAddress, // for compute, consumer is always address of compute env
      publisherAccount,
      oceanNode,
      providerFeesComputeAlgo
    )
    assert(orderTxReceipt, 'order transaction failed')
    algoOrderTxId = orderTxReceipt.hash
    assert(algoOrderTxId, 'transaction id not found')
  })

  it('Initialize compute with dataset tx and algo with tx', async () => {
    // now, we have valid orders for both algo and dataset,
    // expected results:
    //  - dataset should have valid order and providerFee
    //  - algo should have valid order and providerFee

    const dataset: ComputeAsset = {
      documentId: publishedComputeDataset.ddo.id,
      serviceId: publishedComputeDataset.ddo.services[0].id,
      transferTxId: String(datasetOrderTxId)
    }
    const algorithm: ComputeAlgorithm = {
      documentId: publishedAlgoDataset.ddo.id,
      serviceId: publishedAlgoDataset.ddo.services[0].id,
      transferTxId: String(algoOrderTxId)
    }
    const initializeComputeTask: ComputeInitializeCommand = {
      datasets: [dataset],
      algorithm,
      environment: firstEnv.id,
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: computeJobDuration,
      consumerAddress: firstEnv.consumerAddress,
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE
    }
    const resp = await new ComputeInitializeHandler(oceanNode).handle(
      initializeComputeTask
    )

    assert(resp, 'Failed to get response')
    assert(resp.status.httpStatus === 200, 'Failed to get 200 response')
    assert(resp.stream, 'Failed to get stream')
    expect(resp.stream).to.be.instanceOf(Readable)

    const result: any = await streamToObject(resp.stream as Readable)
    initializeResponse = JSON.parse(JSON.stringify(result))
    assert(result.algorithm, 'algorithm does not exist')
    expect(result.algorithm.datatoken?.toLowerCase()).to.be.equal(
      publishedAlgoDataset.datatokenAddress?.toLowerCase()
    )
    assert(
      !('providerFee' in result.algorithm),
      'dataset providerFeeAddress should not exist'
    )
    assert(result.algorithm.validOrder !== false, 'We should have a valid order') // because we started an order earlier
    // dataset checks
    assert(result.datasets.length > 0, 'datasets key does not exist')
    const resultParsed = JSON.parse(JSON.stringify(result.datasets[0]))
    expect(resultParsed.datatoken?.toLowerCase()).to.be.equal(
      publishedComputeDataset.ddo.datatokens[0].address?.toLowerCase()
    )

    assert(
      !('providerFee' in resultParsed),
      'dataset providerFeeAddress should not exist'
    )
    assert(result.datasets[0].validOrder !== false, 'We should have a valid order') // because we started an order earlier
  })

  it('should fail to start a compute job', async () => {
    const nonce = Date.now().toString()
    const message = String(
      (await consumerAccount.getAddress()) + publishedComputeDataset.ddo.id + nonce
    )
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)

    // since ganache does not supports personal_sign, we use wallet account
    const signature = await wallet.signMessage(messageHashBytes)
    const startComputeTask: PaidComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      consumerAddress: await consumerAccount.getAddress(),
      environment: firstEnv.id,
      signature,
      nonce,
      datasets: [
        {
          documentId: publishedComputeDataset.ddo.id,
          serviceId: publishedComputeDataset.ddo.services[0].id,
          transferTxId: '0x123'
        }
      ],
      algorithm: {
        documentId: publishedAlgoDataset.ddo.id,
        serviceId: publishedAlgoDataset.ddo.services[0].id,
        transferTxId: '0x123',
        meta: publishedAlgoDataset.ddo.metadata.algorithm
      },
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: computeJobDuration
      // additionalDatasets?: ComputeAsset[]
      // output?: ComputeOutput
    }
    const response = await new PaidComputeStartHandler(oceanNode).handle(startComputeTask)
    assert(response, 'Failed to get response')
    // should fail, because txId '0x123' is not a valid order
    assert(response.status.httpStatus === 500, 'Failed to get 500 response')
    assert(!response.stream, 'We should not have a stream')
  })

  it('should start a compute job', async () => {
    // first check escrow auth

    let balance = await paymentTokenContract.balanceOf(await consumerAccount.getAddress())
    let funds = await oceanNode.escrow.getUserAvailableFunds(
      DEVELOPMENT_CHAIN_ID,
      await consumerAccount.getAddress(),
      paymentToken
    )
    // make sure we have 0 funds
    if (BigInt(funds.toString()) > BigInt(0)) {
      await escrowContract
        .connect(consumerAccount)
        .withdraw([initializeResponse.payment.token], [funds])
    }
    let auth = await oceanNode.escrow.getAuthorizations(
      DEVELOPMENT_CHAIN_ID,
      paymentToken,
      await consumerAccount.getAddress(),
      firstEnv.consumerAddress
    )
    if (auth.length > 0) {
      // remove any auths
      await escrowContract
        .connect(consumerAccount)
        .authorize(initializeResponse.payment.token, firstEnv.consumerAddress, 0, 0, 0)
    }
    let locks = await oceanNode.escrow.getLocks(
      DEVELOPMENT_CHAIN_ID,
      paymentToken,
      await consumerAccount.getAddress(),
      firstEnv.consumerAddress
    )

    if (locks.length > 0) {
      // cancel all locks
      for (const lock of locks) {
        try {
          await escrowContract
            .connect(consumerAccount)
            .cancelExpiredLocks(lock.jobId, lock.token, lock.payer, lock.payee)
        } catch (e) {}
      }
      locks = await oceanNode.escrow.getLocks(
        DEVELOPMENT_CHAIN_ID,
        paymentToken,
        await consumerAccount.getAddress(),
        firstEnv.consumerAddress
      )
    }
    const locksBefore = locks.length
    const nonce = Date.now().toString()
    const message = String(
      (await consumerAccount.getAddress()) + publishedComputeDataset.ddo.id + nonce
    )
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const startComputeTask: PaidComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      consumerAddress: await consumerAccount.getAddress(),
      signature,
      nonce,
      environment: firstEnv.id,
      datasets: [
        {
          documentId: publishedComputeDataset.ddo.id,
          serviceId: publishedComputeDataset.ddo.services[0].id,
          transferTxId: datasetOrderTxId
        }
      ],
      algorithm: {
        documentId: publishedAlgoDataset.ddo.id,
        serviceId: publishedAlgoDataset.ddo.services[0].id,
        transferTxId: algoOrderTxId,
        meta: publishedAlgoDataset.ddo.metadata.algorithm
      },
      output: {},
      payment: {
        chainId: DEVELOPMENT_CHAIN_ID,
        token: paymentToken
      },
      maxJobDuration: computeJobDuration
      // additionalDatasets?: ComputeAsset[]
      // output?: ComputeOutput
    }
    // it should fail, because we don't have funds & auths in escrow
    let response = await new PaidComputeStartHandler(oceanNode).handle(startComputeTask)
    assert(response.status.httpStatus === 400, 'Failed to get 400 response')
    assert(!response.stream, 'We should not have a stream')
    // let's put funds in escrow & create an auth
    balance = await paymentTokenContract.balanceOf(await consumerAccount.getAddress())
    await paymentTokenContract
      .connect(consumerAccount)
      .approve(initializeResponse.payment.escrowAddress, balance)
    await escrowContract
      .connect(consumerAccount)
      .deposit(initializeResponse.payment.token, balance)
    await escrowContract
      .connect(consumerAccount)
      .authorize(
        initializeResponse.payment.token,
        firstEnv.consumerAddress,
        balance,
        computeJobDuration,
        10
      )
    auth = await oceanNode.escrow.getAuthorizations(
      DEVELOPMENT_CHAIN_ID,
      paymentToken,
      await consumerAccount.getAddress(),
      firstEnv.consumerAddress
    )
    const authBefore = auth[0]
    funds = await oceanNode.escrow.getUserAvailableFunds(
      DEVELOPMENT_CHAIN_ID,
      await consumerAccount.getAddress(),
      paymentToken
    )
    const fundsBefore = funds
    assert(BigInt(funds.toString()) > BigInt(0), 'Should have funds in escrow')
    assert(auth.length > 0, 'Should have authorization')
    assert(
      BigInt(auth[0].maxLockedAmount.toString()) > BigInt(0),
      ' Should have maxLockedAmount in auth'
    )
    assert(
      BigInt(auth[0].maxLockCounts.toString()) > BigInt(0),
      ' Should have maxLockCounts in auth'
    )
    const nonce2 = Date.now().toString()
    const message2 = String(
      (await consumerAccount.getAddress()) + publishedComputeDataset.ddo.id + nonce2
    )
    const consumerMessage2 = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message2))]
    )
    const messageHashBytes2 = ethers.toBeArray(consumerMessage2)
    const signature2 = await wallet.signMessage(messageHashBytes2)
    response = await new PaidComputeStartHandler(oceanNode).handle({
      ...startComputeTask,
      nonce: nonce2,
      signature: signature2
    })
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const jobs = await streamToObject(response.stream as Readable)
    // eslint-disable-next-line prefer-destructuring
    jobId = jobs[0].jobId
    // check escrow
    funds = await oceanNode.escrow.getUserAvailableFunds(
      DEVELOPMENT_CHAIN_ID,
      await consumerAccount.getAddress(),
      paymentToken
    )
    assert(fundsBefore > funds, 'We should have less funds')
    locks = await oceanNode.escrow.getLocks(
      DEVELOPMENT_CHAIN_ID,
      paymentToken,
      await consumerAccount.getAddress(),
      firstEnv.consumerAddress
    )
    assert(locks.length > locksBefore, 'We should have locks')
    auth = await oceanNode.escrow.getAuthorizations(
      DEVELOPMENT_CHAIN_ID,
      paymentToken,
      await consumerAccount.getAddress(),
      firstEnv.consumerAddress
    )
    assert(auth[0].currentLocks > authBefore.currentLocks, 'We should have running jobs')
    assert(
      auth[0].currentLockedAmount > authBefore.currentLockedAmount,
      'We should have higher currentLockedAmount'
    )
  })

  /* it('should start a free docker compute job', async () => {
    const nonce = Date.now().toString()
    const message = String(nonce)
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const startComputeTask: FreeComputeStartCommand = {
      command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      consumerAddress: await consumerAccount.getAddress(),
      signature,
      nonce,
      environment: firstEnv.id,
      datasets: [
        {
          fileObject: computeAsset.services[0].files.files[0],
          documentId: publishedComputeDataset.ddo.id,
          serviceId: publishedComputeDataset.ddo.services[0].id,
          transferTxId: datasetOrderTxId
        }
      ],
      algorithm: {
        fileObject: algoAsset.services[0].files.files[0],
        documentId: publishedAlgoDataset.ddo.id,
        serviceId: publishedAlgoDataset.ddo.services[0].id,
        transferTxId: algoOrderTxId,
        meta: publishedAlgoDataset.ddo.metadata.algorithm
      },
      output: {}
      // additionalDatasets?: ComputeAsset[]
      // output?: ComputeOutput
    }
    const response = await new FreeComputeStartHandler(oceanNode).handle(startComputeTask)
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const jobs = await streamToObject(response.stream as Readable)
    assert(jobs[0].jobId, 'failed to got job id')
    // eslint-disable-next-line prefer-destructuring
    jobId = jobs[0].jobId
  }) */

  it('should start a free docker compute job', async () => {
    const nonce = Date.now().toString()
    const message = String(nonce)
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const startComputeTask: FreeComputeStartCommand = {
      command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      consumerAddress: await wallet.getAddress(),
      signature,
      nonce,
      environment: firstEnv.id,
      datasets: [
        {
          fileObject: computeAsset.services[0].files.files[0],
          documentId: publishedComputeDataset.ddo.id,
          serviceId: publishedComputeDataset.ddo.services[0].id,
          transferTxId: datasetOrderTxId
        }
      ],
      algorithm: {
        fileObject: algoAsset.services[0].files.files[0],
        documentId: publishedAlgoDataset.ddo.id,
        serviceId: publishedAlgoDataset.ddo.services[0].id,
        transferTxId: algoOrderTxId,
        meta: publishedAlgoDataset.ddo.metadata.algorithm
      },
      output: {},
      metadata: {
        key: 'value'
      }
      // additionalDatasets?: ComputeAsset[]
      // output?: ComputeOutput
    }
    const response = await new FreeComputeStartHandler(oceanNode).handle(startComputeTask)
    console.log(response)
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const jobs = await streamToObject(response.stream as Readable)
    assert(jobs[0].jobId, 'failed to got job id')
    // eslint-disable-next-line prefer-destructuring
    jobId = jobs[0].jobId
  })

  it('should get job status by jobId', async () => {
    const statusComputeTask: ComputeGetStatusCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      consumerAddress: null,
      agreementId: null,
      jobId
    }
    const response = await new ComputeGetStatusHandler(oceanNode).handle(
      statusComputeTask
    )
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)
    const jobs = await streamToObject(response.stream as Readable)
    expect(jobs[0].metadata).to.deep.equal({ key: 'value' })
    console.log(jobs)
  })

  it('should get job status by consumer', async () => {
    const statusComputeTask: ComputeGetStatusCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      consumerAddress: consumerAccount.address,
      agreementId: null,
      jobId: null
    }
    const response = await new ComputeGetStatusHandler(oceanNode).handle(
      statusComputeTask
    )
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)
    const jobs = await streamToObject(response.stream as Readable)
    console.log(jobs)
  })
  it('should stop a compute job', async () => {
    const nonce = Date.now().toString()
    const message = String((await consumerAccount.getAddress()) + (jobId || ''))
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const stopComputeTask: ComputeStopCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_STOP,
      consumerAddress: await consumerAccount.getAddress(),
      signature,
      nonce,
      jobId
    }
    const response = await new ComputeStopHandler(oceanNode).handle(stopComputeTask)
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)
  })
  it('should deny the Free job due to signature (directCommand payload)', async function () {
    freeComputeStartPayload.environment = firstEnv.id
    const command: FreeComputeStartCommand = freeComputeStartPayload
    const handler = new FreeComputeStartHandler(oceanNode)
    const response = await handler.handle(command)
    assert(response.status.httpStatus === 401, 'Failed to get 401 response')
    assert(response.stream === null, 'Should not get stream')
  })
  it('should deny the Free job due to bad container image (directCommand payload)', async function () {
    const nonce = Date.now().toString()
    const message = String(nonce)
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    freeComputeStartPayload.signature = signature
    freeComputeStartPayload.nonce = nonce
    freeComputeStartPayload.environment = firstEnv.id
    freeComputeStartPayload.consumerAddress = await wallet.getAddress()
    const command: FreeComputeStartCommand = freeComputeStartPayload
    const handler = new FreeComputeStartHandler(oceanNode)
    const response = await handler.handle(command)
    assert(response.status.httpStatus === 500, 'Failed to get 500 response')
    assert(response.stream === null, 'Should not get stream')
    assert(
      response.status.error.includes(
        freeComputeStartPayload.algorithm.meta.container.image
      ),
      'Should have image error'
    )
  })

  // algo and checksums related
  describe('C2D algo and checksums related', () => {
    it('should publish AlgoDDO', async () => {
      const tx = await (factoryContract as any).createNftWithErc20(
        {
          name: '72120Bundle',
          symbol: '72Bundle',
          templateIndex: 1,
          tokenURI: 'https://oceanprotocol.com/nft/',
          transferable: true,
          owner: publisherAddress
        },
        {
          strings: ['ERC20B1', 'ERC20DT1Symbol'],
          templateIndex: 1,
          addresses: [publisherAddress, ZeroAddress, ZeroAddress, ZeroAddress],
          uints: [1000, 0],
          bytess: []
        }
      )
      const txFactoryContract = await tx.wait()
      assert(txFactoryContract, 'transaction failed')
      const nftEvent = getEventFromTx(txFactoryContract, 'NFTCreated')
      const erc20Event = getEventFromTx(txFactoryContract, 'TokenCreated')
      const dataNftAddress = nftEvent.args[0]
      const datatokenAddress = erc20Event.args[0]
      assert(dataNftAddress, 'find nft created failed')
      assert(datatokenAddress, 'find datatoken created failed')

      const nftContract = new ethers.Contract(
        dataNftAddress,
        ERC721Template.abi,
        publisherAccount
      )
      algoDDO.id =
        'did:op:' +
        createHash('sha256')
          .update(getAddress(dataNftAddress) + chainId.toString(10))
          .digest('hex')
      algoDDO.nftAddress = dataNftAddress
      algoDDO.services[0].datatokenAddress = datatokenAddress

      const files = {
        datatokenAddress: '0x0',
        nftAddress: '0x0',
        files: [
          {
            type: 'url',
            url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
            method: 'get'
          }
        ]
      }
      const filesData = Uint8Array.from(Buffer.from(JSON.stringify(files)))
      algoDDO.services[0].files = await encrypt(filesData, EncryptMethod.ECIES)

      const metadata = hexlify(Buffer.from(JSON.stringify(algoDDO)))
      const hash = createHash('sha256').update(metadata).digest('hex')

      const setMetaDataTx = await nftContract.setMetaData(
        0,
        'http://v4.provider.oceanprotocol.com',
        '0x123',
        '0x00',
        metadata,
        '0x' + hash,
        []
      )
      const txReceipt = await setMetaDataTx.wait()
      assert(txReceipt, 'set metadata failed')
    })

    it('should publish DatasetDDO', async () => {
      const tx = await (factoryContract as any).createNftWithErc20(
        {
          name: '72120Bundle',
          symbol: '72Bundle',
          templateIndex: 1,
          tokenURI: 'https://oceanprotocol.com/nft/',
          transferable: true,
          owner: publisherAddress
        },
        {
          strings: ['ERC20B1', 'ERC20DT1Symbol'],
          templateIndex: 1,
          addresses: [publisherAddress, ZeroAddress, ZeroAddress, ZeroAddress],
          uints: [1000, 0],
          bytess: []
        }
      )
      const txFactoryContract = await tx.wait()
      assert(txFactoryContract, 'transaction failed')
      const nftEvent = getEventFromTx(txFactoryContract, 'NFTCreated')
      const erc20Event = getEventFromTx(txFactoryContract, 'TokenCreated')
      const dataNftAddress = nftEvent.args[0]
      const datatokenAddress = erc20Event.args[0]
      assert(dataNftAddress, 'find nft created failed')
      assert(datatokenAddress, 'find datatoken created failed')

      const nftContract = new ethers.Contract(
        dataNftAddress,
        ERC721Template.abi,
        publisherAccount
      )
      datasetDDO.id =
        'did:op:' +
        createHash('sha256')
          .update(getAddress(dataNftAddress) + chainId.toString(10))
          .digest('hex')
      datasetDDO.nftAddress = dataNftAddress
      datasetDDO.services[0].datatokenAddress = datatokenAddress

      const files = {
        datatokenAddress: '0x0',
        nftAddress: '0x0',
        files: [
          {
            type: 'url',
            url: 'https://github.com/datablist/sample-csv-files/raw/main/files/organizations/organizations-100.csv',
            method: 'GET'
          }
        ]
      }
      const filesData = Uint8Array.from(Buffer.from(JSON.stringify(files)))
      datasetDDO.services[0].files = await encrypt(filesData, EncryptMethod.ECIES)

      datasetDDO.services[0].compute = {
        allowRawAlgorithm: false,
        allowNetworkAccess: true,
        publisherTrustedAlgorithmPublishers: setTrustedAlgosEmpty
          ? []
          : [publisherAddress],
        publisherTrustedAlgorithms: setTrustedAlgosEmpty
          ? []
          : [
              {
                did: algoDDO.id,
                filesChecksum:
                  'f6a7b95e4a2e3028957f69fdd2dac27bd5103986b2171bc8bfee68b52f874dcd',
                containerSectionChecksum:
                  'ba8885fcc7d366f058d6c3bb0b7bfe191c5f85cb6a4ee3858895342436c23504'
              }
            ]
      }

      const metadata = hexlify(Buffer.from(JSON.stringify(datasetDDO)))
      const hash = createHash('sha256').update(metadata).digest('hex')

      const setMetaDataTx = await nftContract.setMetaData(
        0,
        'http://v4.provider.oceanprotocol.com',
        '0x123',
        '0x00',
        metadata,
        '0x' + hash,
        []
      )
      const txReceipt = await setMetaDataTx.wait()
      assert(txReceipt, 'set metadata failed')
    })

    it('should getAlgoChecksums', async function () {
      const { ddo, wasTimeout } = await waitToIndex(
        algoDDO.id,
        EVENTS.METADATA_CREATED,
        DEFAULT_TEST_TIMEOUT,
        true
      )
      const algoDDOTest = ddo
      if (algoDDOTest) {
        const algoChecksums = await getAlgoChecksums(
          algoDDOTest.id,
          algoDDOTest.services[0].id,
          oceanNode
        )
        expect(algoChecksums.files).to.equal(
          'f6a7b95e4a2e3028957f69fdd2dac27bd5103986b2171bc8bfee68b52f874dcd'
        )
        expect(algoChecksums.container).to.equal(
          'ba8885fcc7d366f058d6c3bb0b7bfe191c5f85cb6a4ee3858895342436c23504'
        )
      } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    })

    it('should validateAlgoForDataset', async function () {
      this.timeout(DEFAULT_TEST_TIMEOUT * 10)
      const { ddo, wasTimeout } = await waitToIndex(
        algoDDO.id,
        EVENTS.METADATA_CREATED,
        DEFAULT_TEST_TIMEOUT * 2,
        true
      )

      const algoDDOTest = ddo
      if (algoDDOTest) {
        const algoChecksums = await getAlgoChecksums(
          algoDDOTest.id,
          algoDDOTest.services[0].id,
          oceanNode
        )
        const { ddo, wasTimeout } = await waitToIndex(
          datasetDDO.id,
          EVENTS.METADATA_CREATED,
          DEFAULT_TEST_TIMEOUT * 2,
          true
        )

        const datasetDDOTest = ddo
        const datasetInstance = DDOManager.getDDOClass(datasetDDO)
        if (datasetDDOTest) {
          const result = await validateAlgoForDataset(
            algoDDOTest.id,
            algoChecksums,
            datasetInstance,
            datasetDDOTest.services[0].id,
            oceanNode
          )
          // datasetDDOTest does not have set
          // publisherTrustedAlgorithms, nor
          // publisherTrustedAlgorithmPublishers
          // expect the result to be true
          expect(result).to.equal(true)
        } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
      } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    })
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})
