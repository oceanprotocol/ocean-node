import { expect, assert } from 'chai'
import {
  ComputeGetEnvironmentsHandler,
  ComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeInitializeHandler
} from '../../components/core/compute/index.js'
import type {
  ComputeStartCommand,
  ComputeStopCommand,
  ComputeGetStatusCommand,
  ComputeInitializeCommand
} from '../../@types/commands.js'
import type {
  ComputeAsset,
  ComputeAlgorithm,
  ComputeEnvironment
} from '../../@types/C2D.js'
import {
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
import { streamToObject } from '../../utils/util.js'
import { JsonRpcProvider, Signer, ethers } from 'ethers'
import { publishAsset, orderAsset } from '../utils/assets.js'
import { computeAsset, algoAsset } from '../data/assets.js'
import { RPCS } from '../../@types/blockchain.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

import { ProviderFees } from '../../@types/Fees.js'

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
  let providerFeesComputeDataset: ProviderFees
  let providerFeesComputeAlgo: ProviderFees
  const now = new Date().getTime() / 1000
  const computeJobValidUntil = now + 60 * 15 // 15 minutes from now should be enough
  let firstEnv: ComputeEnvironment

  const wallet = new ethers.Wallet(
    '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
  )
  // const chainId = DEVELOPMENT_CHAIN_ID
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  before(async () => {
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260'])
        ]
      )
    )
    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
    //  eslint-disable-next-line no-unused-vars
    const indexer = new OceanIndexer(dbconn, mockSupportedNetworks)

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
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
      EVENTS.METADATA_CREATED
    )
    // consider possible timeouts
    if (!computeDatasetResult.ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(
        computeDatasetResult.wasTimeout
      )
    }
    const algoDatasetResult = await waitToIndex(
      publishedAlgoDataset.ddo.id,
      EVENTS.METADATA_CREATED
    )
    if (!algoDatasetResult.ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(
        algoDatasetResult.wasTimeout
      )
    }
  })
  it('Get compute environments', async () => {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      chainId: 8996
    }
    const response = await new ComputeGetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    computeEnvironments = await streamToObject(response.stream as Readable)
    // expect 2 envs
    expect(computeEnvironments.length === 2, 'incorrect length')
    for (const computeEnvironment of computeEnvironments) {
      assert(computeEnvironment.id, 'id missing in computeEnvironments')
      assert(
        computeEnvironment.consumerAddress,
        'consumerAddress missing in computeEnvironments'
      )
      assert(computeEnvironment.lastSeen, 'lastSeen missing in computeEnvironments')
      assert(computeEnvironment.id.startsWith('0x'), 'id should start with 0x')
      assert(computeEnvironment.cpuNumber > 0, 'cpuNumber missing in computeEnvironments')
      assert(computeEnvironment.ramGB > 0, 'ramGB missing in computeEnvironments')
      assert(computeEnvironment.diskGB > 0, 'diskGB missing in computeEnvironments')
      assert(computeEnvironment.maxJobs > 0, 'maxJobs missing in computeEnvironments')
      assert(
        computeEnvironment.maxJobDuration > 0,
        'maxJobDuration missing in computeEnvironments'
      )
    }
    firstEnv = computeEnvironments[0]
  })

  it('Initialize compute without transaction IDs', async () => {
    const dataset: ComputeAsset = {
      documentId: publishedComputeDataset.ddo.id,
      serviceId: publishedComputeDataset.ddo.services[0].id
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
    assert(
      result.algorithm.datatoken === publishedAlgoDataset.datatokenAddress,
      'incorrect datatoken address for algo'
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
    assert(
      resultParsed.datatoken === publishedComputeDataset.datatokenAddress,
      'incorrect datatoken address for dataset'
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
    assert(
      result.algorithm.datatoken === publishedAlgoDataset.datatokenAddress,
      'incorrect datatoken address for algo'
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
    assert(
      resultParsed.datatoken === publishedComputeDataset.datatokenAddress,
      'incorrect datatoken address for dataset'
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
    assert(
      result.algorithm.datatoken === publishedAlgoDataset.datatokenAddress,
      'incorrect datatoken address for algo'
    )
    assert(
      !('providerFee' in result.algorithm),
      'dataset providerFeeAddress should not exist'
    )
    assert(result.algorithm.validOrder !== false, 'We should have a valid order') // because we started an order earlier
    // dataset checks
    assert(result.datasets.length > 0, 'datasets key does not exist')
    const resultParsed = JSON.parse(JSON.stringify(result.datasets[0]))
    assert(
      resultParsed.datatoken === publishedComputeDataset.datatokenAddress,
      'incorrect datatoken address for dataset'
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
      environment: computeEnvironments[0].id,
      dataset: {
        documentId: publishedComputeDataset.ddo.id,
        serviceId: publishedComputeDataset.ddo.services[0].id,
        transferTxId: '0x123'
      },
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
      environment: computeEnvironments[0].id,
      dataset: {
        documentId: publishedComputeDataset.ddo.id,
        serviceId: publishedComputeDataset.ddo.services[0].id,
        transferTxId: datasetOrderTxId
      },
      algorithm: {
        documentId: publishedAlgoDataset.ddo.id,
        serviceId: publishedAlgoDataset.ddo.services[0].id,
        transferTxId: algoOrderTxId,
        meta: publishedAlgoDataset.ddo.metadata.algorithm
      }
      // additionalDatasets?: ComputeAsset[]
      // output?: ComputeOutput
    }
    const response = await new ComputeStartHandler(oceanNode).handle(startComputeTask)
    assert(response, 'Failed to get response')
    // should fail, because txId '0x123' is not a valid order
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const jobs = await streamToObject(response.stream as Readable)
    // eslint-disable-next-line prefer-destructuring
    jobId = jobs[0].jobId
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
  it('should get job status by jobId', async () => {
    const statusComputeTask: ComputeGetStatusCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      consumerAddress: null,
      did: null,
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
      did: null,
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
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
