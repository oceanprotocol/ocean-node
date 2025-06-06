import { expect, assert } from 'chai'
import {
  ComputeGetEnvironmentsHandler,
  ComputeInitializeHandler,
  PaidComputeStartHandler
} from '../../components/core/compute/index.js'
import type {
  PaidComputeStartCommand,
  ComputeInitializeCommand
} from '../../@types/commands.js'
import type {
  ComputeAsset,
  ComputeAlgorithm,
  ComputeEnvironment
} from '../../@types/C2D/C2D.js'
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
import { ethers, hexlify, JsonRpcProvider, Signer } from 'ethers'
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

import { ProviderComputeInitializeResults } from '../../@types/Fees.js'
import { homedir } from 'os'
import { DEVELOPMENT_CHAIN_ID, getOceanArtifactsAdresses } from '../../utils/address.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import OceanToken from '@oceanprotocol/contracts/artifacts/contracts/utils/OceanToken.sol/OceanToken.json' assert { type: 'json' }
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' assert { type: 'json' }
import { createHash } from 'crypto'
import { getAlgoChecksums } from '../../components/core/compute/utils.js'

describe('Trusted algorithms Flow', () => {
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
  let indexer: OceanIndexer
  // const now = new Date().getTime() / 1000
  const computeJobDuration = 60 * 15 // 15 minutes from now should be enough
  let firstEnv: ComputeEnvironment

  const wallet = new ethers.Wallet(
    '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209'
  )
  // const chainId = DEVELOPMENT_CHAIN_ID
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
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
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(config, dbconn, null, null, null)
    indexer = new OceanIndexer(dbconn, config.indexingNetworks)
    oceanNode.addIndexer(indexer)
    oceanNode.addC2DEngines()

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
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
    initializeResponse = (await streamToObject(
      resp.stream as Readable
    )) as ProviderComputeInitializeResults
  })

  it('should start an order on dataset', async function () {
    const orderTxReceipt = await orderAsset(
      publishedComputeDataset.ddo,
      0,
      consumerAccount,
      firstEnv.consumerAddress, // for compute, consumer is always address of compute env
      publisherAccount,
      oceanNode,
      initializeResponse.datasets[0].providerFee
    )
    assert(orderTxReceipt, 'order transaction failed')
    datasetOrderTxId = orderTxReceipt.hash
    assert(datasetOrderTxId, 'transaction id not found')
  })
  it('should start an order on algorithm', async function () {
    const orderTxReceipt = await orderAsset(
      publishedAlgoDataset.ddo,
      0,
      consumerAccount,
      firstEnv.consumerAddress, // for compute, consumer is always address of compute env
      publisherAccount,
      oceanNode,
      initializeResponse.algorithm.providerFee
    )
    assert(orderTxReceipt, 'order transaction failed')
    algoOrderTxId = orderTxReceipt.hash
    assert(algoOrderTxId, 'transaction id not found')
  })
  it('should not start a compute job because algorithm is not trusted by dataset', async () => {
    let balance = await paymentTokenContract.balanceOf(await consumerAccount.getAddress())
    const nonce = Date.now().toString()
    const message = String(nonce)
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
    }
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

    const response = await new PaidComputeStartHandler(oceanNode).handle(startComputeTask)
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 400, 'Failed to get 400 response')
    assert(
      response.status.error ===
        `Algorithm ${publishedAlgoDataset.ddo.id} not allowed to run on the dataset: ${publishedComputeDataset.ddo.id}`,
      'Inconsistent error message'
    )
    assert(response.stream === null, 'Failed to get stream')
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
    const auth = await oceanNode.escrow.getAuthorizations(
      DEVELOPMENT_CHAIN_ID,
      paymentToken,
      await consumerAccount.getAddress(),
      firstEnv.consumerAddress
    )
    assert(auth.length > 0, 'Should have authorization')
    assert(
      BigInt(auth[0].maxLockedAmount.toString()) > BigInt(0),
      ' Should have maxLockedAmount in auth'
    )
    assert(
      BigInt(auth[0].maxLockCounts.toString()) > BigInt(0),
      ' Should have maxLockCounts in auth'
    )
    const response = await new PaidComputeStartHandler(oceanNode).handle(startComputeTask)
    console.log(`response: ${response.status.httpStatus}`)
    console.log(`response: ${JSON.stringify(response)}`)
    assert(response, 'Failed to get response')
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const jobs = await streamToObject(response.stream as Readable)
    // eslint-disable-next-line prefer-destructuring
    jobId = jobs[0].jobId
    assert(jobId)
  })
  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    indexer.stopAllThreads()
  })
})
