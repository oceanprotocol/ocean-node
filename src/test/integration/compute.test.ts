import { expect, assert } from 'chai'
import {
  ComputeGetEnvironmentsHandler,
  ComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeGetResultHandler
} from '../../components/core/compute.js'
import type {
  ComputeGetEnvironmentsCommand,
  ComputeStartCommand,
  ComputeStopCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand
} from '../../@types/commands.js'
import { getConfiguration } from '../../utils/config.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { waitToIndex, delay } from './testUtils.js'
import { streamToObject, streamToString } from '../../utils/util.js'
import { publishAsset } from '../utils/assets.js'
import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress
} from 'ethers'
import { computeAsset, algoAsset } from '../data/ddo_compute.js'
import { isRunningContinousIntegrationEnv } from '../utils/utils.js'

describe('Compute', () => {
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode
  let computeAsset1
  let algoAsset1
  let provider: any
  let publisherAccount: any
  let consumerAccount: any
  let computeEnvironments: any
  let publishedComputeDataset: any
  let publishedAlgoDataset: any
  let jobId: string
  before(async () => {
    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    consumerAccount = (await provider.getSigner(1)) as Signer
    publisherAccount = (await provider.getSigner(0)) as Signer
  })

  it('Sets up compute envs', async () => {
    assert(oceanNode, 'Failed to instantiate OceanNode')
    assert(config.c2dClusters, 'Failed to get c2dClusters')
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
  })

  // let's publish assets & algos
  it('should publish compute datasets & algos', async () => {
    publishedComputeDataset = await publishAsset(computeAsset, publisherAccount)
    publishedAlgoDataset = await publishAsset(algoAsset, publisherAccount)
  })
  it('should start a compute job', async () => {
    const wallet = new ethers.Wallet(
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    )
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
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const jobs = await streamToObject(response.stream as Readable)
    // eslint-disable-next-line prefer-destructuring
    jobId = jobs[0].jobId
  })
  it('should stop a compute job', async () => {
    const wallet = new ethers.Wallet(
      '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
    )
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
})
