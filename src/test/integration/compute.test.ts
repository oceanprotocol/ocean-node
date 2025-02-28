import { expect, assert } from 'chai'
import {
  ComputeGetEnvironmentsHandler,
  // ComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  // ComputeInitializeHandler,
  FreeComputeStartHandler
} from '../../components/core/compute/index.js'
import type {
  ComputeStartCommand,
  ComputeStopCommand,
  ComputeGetStatusCommand,
  // ComputeInitializeCommand,
  FreeComputeStartCommand
} from '../../@types/commands.js'
import type {
  // ComputeAsset,
  // ComputeAlgorithm,
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
// import { publishAsset, orderAsset } from '../utils/assets.js'
import { publishAsset } from '../utils/assets.js'
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

// import { ProviderFees } from '../../@types/Fees.js'
import { homedir } from 'os'
import { publishAlgoDDO, publishDatasetDDO } from '../data/ddo.js'
import { DEVELOPMENT_CHAIN_ID, getOceanArtifactsAdresses } from '../../utils/address.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { createHash } from 'crypto'
import { encrypt } from '../../utils/crypt.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import {
  getAlgoChecksums,
  validateAlgoForDataset
} from '../../components/core/compute/utils.js'

import { freeComputeStartPayload } from '../data/commands.js'

describe('Compute', () => {
  let previousConfiguration: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode
  let provider: any
  let publisherAccount: any
  // let consumerAccount: any
  let computeEnvironments: any
  let publishedComputeDataset: any
  let publishedAlgoDataset: any
  let jobId: string
  let datasetOrderTxId: any
  let algoOrderTxId: any
  // let providerFeesComputeDataset: ProviderFees
  // let providerFeesComputeAlgo: ProviderFees
  let indexer: OceanIndexer
  // const now = new Date().getTime() / 1000
  // const computeJobValidUntil = now + 60 * 15 // 15 minutes from now should be enough
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

  before(async () => {
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
            '":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":60,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1000000000},{"id":"disk","max":1000000000}]}}]'
        ]
      )
    )
    config = await getConfiguration(true)
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
    indexer = new OceanIndexer(dbconn, config.indexingNetworks)
    oceanNode.addIndexer(indexer)
    oceanNode.addC2DEngines(config)

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    // consumerAccount = (await provider.getSigner(1)) as Signer

    const artifactsAddresses = getOceanArtifactsAdresses()
    publisherAddress = await publisherAccount.getAddress()
    algoDDO = { ...publishAlgoDDO }
    datasetDDO = { ...publishDatasetDDO }
    factoryContract = new ethers.Contract(
      artifactsAddresses.development.ERC721Factory,
      ERC721Factory.abi,
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
      EVENTS.METADATA_CREATED,
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
  /*
  it('Initialize compute without transaction IDs', async () => {
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
      compute: {
        env: firstEnv.id,
        validUntil: computeJobValidUntil
      },
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
  })

  it('should start an order', async function () {
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
    // now, we have a valid order for dataset, with valid compute provider fees
    // expected results:
    //  - dataset should have valid order
    //  - dataset should have valid providerFee
    //  - algo should not have any valid order or providerFee

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
      compute: {
        env: firstEnv.id,
        validUntil: computeJobValidUntil
      },
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
      compute: {
        env: firstEnv.id,
        validUntil: computeJobValidUntil
      },
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
    const message = String(nonce)
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const startComputeTask: ComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      consumerAddress: await wallet.getAddress(),
      signature,
      nonce,
      environment: firstEnv.id,
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
      }
      // additionalDatasets?: ComputeAsset[]
      // output?: ComputeOutput
    }
    const response = await new ComputeStartHandler(oceanNode).handle(startComputeTask)
    assert(response, 'Failed to get response')
    // should fail, because txId '0x123' is not a valid order
    assert(response.status.httpStatus === 500, 'Failed to get 500 response')
    assert(!response.stream, 'We should not have a stream')
  })

  it('should start a compute job', async () => {
    // first need to check the existing envs
    // If only FREE envs than start a free compute job instead of a regular/payed one

    const nonce = Date.now().toString()
    const message = String(nonce)
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const startComputeTask: ComputeStartCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      consumerAddress: await wallet.getAddress(),
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
      output: {}
      // additionalDatasets?: ComputeAsset[]
      // output?: ComputeOutput
    }
    const response = await new ComputeStartHandler(oceanNode).handle(startComputeTask)
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const jobs = await streamToObject(response.stream as Readable)
    // eslint-disable-next-line prefer-destructuring
    jobId = jobs[0].jobId
  })
  */
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
    const startComputeTask: ComputeStartCommand = {
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
    console.log(jobs)
  })

  it('should get job status by consumer', async () => {
    const statusComputeTask: ComputeGetStatusCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      consumerAddress: wallet.address,
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
    const message = String(nonce)
    // sign message/nonce
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const signature = await wallet.signMessage(messageHashBytes)
    const stopComputeTask: ComputeStopCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_STOP,
      consumerAddress: await wallet.getAddress(),
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
    assert(response.status.httpStatus === 500, 'Failed to get 500 response')
    assert(response.stream === null, 'Should not get stream')
    assert(
      response.status.error.includes('Invalid nonce or signature'),
      'Should have signature error'
    )
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
      this.timeout(DEFAULT_TEST_TIMEOUT * 3)
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
        if (datasetDDOTest) {
          const result = await validateAlgoForDataset(
            algoDDOTest.id,
            algoChecksums,
            datasetDDOTest,
            datasetDDOTest.services[0].id,
            oceanNode
          )
          expect(result).to.equal(!setTrustedAlgosEmpty)
        } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
      } else expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    })
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})
