import { assert, expect } from 'chai'
import { Readable } from 'stream'
import { Signer, JsonRpcProvider, ethers, Contract, parseUnits } from 'ethers'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'
import { downloadAsset } from '../data/assets.js'
import { publishAsset } from '../utils/assets.js'
import { homedir } from 'os'
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
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration,
  EVENTS,
  INDEXER_CRAWLING_EVENTS
} from '../../utils/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20Template.sol/ERC20Template.json' assert { type: 'json' }
import { DEVELOPMENT_CHAIN_ID, getOceanArtifactsAdresses } from '../../utils/address.js'
import {
  AdminReindexChainCommand,
  AdminReindexTxCommand,
  AdminStopNodeCommand,
  JobStatus,
  IndexingCommand,
  StartStopIndexingCommand,
  AdminCollectFeesCommand
} from '../../@types/commands.js'
import { StopNodeHandler } from '../../components/core/admin/stopNodeHandler.js'
import { ReindexTxHandler } from '../../components/core/admin/reindexTxHandler.js'
import { ReindexChainHandler } from '../../components/core/admin/reindexChainHandler.js'
import { FindDdoHandler } from '../../components/core/handler/ddoHandler.js'
import { sleep, streamToObject } from '../../utils/util.js'
import { expectedTimeoutFailure, waitToIndex } from './testUtils.js'
import { IndexingThreadHandler } from '../../components/core/admin/IndexingThreadHandler.js'
import { CoreHandlersRegistry } from '../../components/core/handler/coreHandlersRegistry.js'
import {
  INDEXER_CRAWLING_EVENT_EMITTER,
  OceanIndexer
} from '../../components/Indexer/index.js'
import { getCrawlingInterval } from '../../components/Indexer/utils.js'
import { ReindexTask } from '../../components/Indexer/crawlerThread.js'
import { create256Hash } from '../../utils/crypt.js'
import { CollectFeesHandler } from '../../components/core/admin/collectFeesHandler.js'
import { getProviderFeeToken } from '../../components/core/utils/feesHandler.js'

describe('Should test admin operations', () => {
  let config: OceanNodeConfig
  let oceanNode: OceanNode
  let publishedDataset: any
  let dbconn: Database
  let indexer: OceanIndexer
  const currentDate = new Date()
  const expiryTimestamp = new Date(
    currentDate.getFullYear() + 1,
    currentDate.getMonth(),
    currentDate.getDate()
  ).getTime()
  const provider = new JsonRpcProvider('http://127.0.0.1:8545')
  const wallet = new ethers.Wallet(
    '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
    provider
  )
  const destinationWallet = new ethers.Wallet(
    '0xef4b441145c1d0f3b4bc6d61d29f5c6e502359481152f869247c7a4244d45209',
    provider
  )

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

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
          JSON.stringify([await wallet.getAddress()]),
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
        ]
      )
    )

    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(
      config,
      dbconn,
      undefined,
      undefined,
      undefined,
      true
    )
    indexer = new OceanIndexer(dbconn, config.indexingNetworks)
    oceanNode.addIndexer(indexer)
  })

  async function getSignature(message: string) {
    return await wallet.signMessage(message)
  }

  it('validation should pass for stop node command', async () => {
    const signature = await getSignature(expiryTimestamp.toString())

    const stopNodeCommand: AdminStopNodeCommand = {
      command: PROTOCOL_COMMANDS.STOP_NODE,
      node: config.keys.peerId.toString(),
      expiryTimestamp,
      signature
    }
    const validationResponse = await new StopNodeHandler(oceanNode).validate(
      stopNodeCommand
    )
    assert(validationResponse, 'invalid stop node validation response')
    assert(validationResponse.valid === true, 'validation for stop node command failed')
  })

  it('should test command for collect fees', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    // -----------------------------------------
    // CollectFeesHandler
    const collectFeesHandler: CollectFeesHandler = CoreHandlersRegistry.getInstance(
      oceanNode
    ).getHandler(PROTOCOL_COMMANDS.COLLECT_FEES) as CollectFeesHandler

    const signature = await getSignature(expiryTimestamp.toString())
    const collectFeesCommand: AdminCollectFeesCommand = {
      command: PROTOCOL_COMMANDS.COLLECT_FEES,
      tokenAddress: await getProviderFeeToken(DEVELOPMENT_CHAIN_ID),
      chainId: DEVELOPMENT_CHAIN_ID,
      tokenAmount: 0.01,
      destinationAddress: await destinationWallet.getAddress(),
      expiryTimestamp,
      signature
    }
    const validationResponse = await collectFeesHandler.validate(collectFeesCommand)
    assert(validationResponse, 'invalid collect fees validation response')
    assert(
      validationResponse.valid === true,
      'validation for collect fees command failed'
    )
    const providerWallet = wallet
    const token = new Contract(
      collectFeesCommand.tokenAddress.toLowerCase(),
      ERC20Template.abi,
      providerWallet
    )
    const balanceBefore = await token.balanceOf(await destinationWallet.getAddress())
    expect((await collectFeesHandler.validate(collectFeesCommand)).valid).to.be.equal(
      true
    ) // OK
    const result = await collectFeesHandler.handle(collectFeesCommand)
    expect(result.status.httpStatus).to.be.equal(200) // OK

    const obj = await streamToObject(result.stream as Readable)

    expect(obj.tx).to.be.not.equal(null) // OK
    expect(obj.message).to.be.equal('Fees successfully transfered to admin!') // OK
    expect(await token.balanceOf(await destinationWallet.getAddress())).to.be.equal(
      balanceBefore + parseUnits(collectFeesCommand.tokenAmount.toString(), 'ether')
    )

    // Test incorrect values for command: node ID and big amount
    const collectFeesCommandWrongNode: AdminCollectFeesCommand = {
      command: PROTOCOL_COMMANDS.COLLECT_FEES,
      node: 'My peerID', // dummy peer ID
      tokenAddress: getOceanArtifactsAdresses().development.Ocean,
      chainId: DEVELOPMENT_CHAIN_ID,
      tokenAmount: 0.01,
      destinationAddress: await wallet.getAddress(),
      expiryTimestamp,
      signature
    }
    expect(
      (await collectFeesHandler.handle(collectFeesCommandWrongNode)).status.httpStatus
    ).to.be.equal(400) // NOK

    const collectFeesCommandWrongAmount: AdminCollectFeesCommand = {
      command: PROTOCOL_COMMANDS.COLLECT_FEES,
      tokenAddress: getOceanArtifactsAdresses().development.Ocean,
      chainId: DEVELOPMENT_CHAIN_ID,
      tokenAmount: 366666666666, // big amount
      destinationAddress: await wallet.getAddress(),
      expiryTimestamp,
      signature
    }
    expect(
      (await collectFeesHandler.handle(collectFeesCommandWrongAmount)).status.httpStatus
    ).to.be.equal(400) // NOK
  })

  it('should publish dataset', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    publishedDataset = await publishAsset(downloadAsset, wallet as Signer)
    const { ddo, wasTimeout } = await waitToIndex(
      publishedDataset.ddo.id,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 2
    )
    if (!ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    }
  })

  it('should pass for reindex tx command', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    await waitToIndex(publishedDataset.ddo.did, EVENTS.METADATA_CREATED)
    const signature = await getSignature(expiryTimestamp.toString())

    const reindexTxCommand: AdminReindexTxCommand = {
      command: PROTOCOL_COMMANDS.REINDEX_TX,
      node: config.keys.peerId.toString(),
      txId: publishedDataset.trxReceipt.hash,
      chainId: DEVELOPMENT_CHAIN_ID,
      expiryTimestamp,
      signature
    }
    const reindexTxHandler = new ReindexTxHandler(oceanNode)
    const validationResponse = await reindexTxHandler.validate(reindexTxCommand)
    assert(validationResponse, 'invalid reindex tx validation response')
    assert(validationResponse.valid === true, 'validation for reindex tx command failed')

    let reindexResult: any = null
    INDEXER_CRAWLING_EVENT_EMITTER.addListener(
      INDEXER_CRAWLING_EVENTS.REINDEX_QUEUE_POP, // triggered when tx completes and removed from queue
      (data) => {
        // {ReindexTask}
        reindexResult = data.result as ReindexTask
        expect(reindexResult.txId).to.be.equal(publishedDataset.trxReceipt.hash)
        expect(reindexResult.chainId).to.be.equal(DEVELOPMENT_CHAIN_ID)
      }
    )

    const handlerResponse = await reindexTxHandler.handle(reindexTxCommand)
    assert(handlerResponse, 'handler resp does not exist')
    assert(handlerResponse.status.httpStatus === 200, 'incorrect http status')
    const findDDOTask = {
      command: PROTOCOL_COMMANDS.FIND_DDO,
      id: publishedDataset.ddo.id
    }

    const responseJob: JobStatus = await streamToObject(
      handlerResponse.stream as Readable
    )
    assert(indexer.getJobsPool().length >= 1, 'job id not found in pool')
    assert(responseJob.command === PROTOCOL_COMMANDS.REINDEX_TX, 'command not expected')
    assert(responseJob.jobId.includes(PROTOCOL_COMMANDS.REINDEX_TX))
    assert(responseJob.timestamp <= new Date().getTime().toString())
    assert(
      responseJob.hash ===
        create256Hash(
          [reindexTxCommand.chainId.toString(), reindexTxCommand.txId].join('')
        ),
      'wrong job hash'
    )
    // wait a bit
    await sleep(getCrawlingInterval() * 2)
    if (reindexResult !== null) {
      assert('chainId' in reindexResult, 'expected a chainId')
      assert('txId' in reindexResult, 'expected a txId')
    }

    const response = await new FindDdoHandler(oceanNode).handle(findDDOTask)
    const actualDDO = await streamToObject(response.stream as Readable)
    assert(actualDDO[0].id === publishedDataset.ddo.id, 'DDO id not matching')
  })

  it('should pass for reindex chain command', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const signature = await getSignature(expiryTimestamp.toString())
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const { ddo, wasTimeout } = await waitToIndex(
      publishedDataset.ddo.did,
      EVENTS.METADATA_CREATED,
      DEFAULT_TEST_TIMEOUT * 2
    )
    if (!ddo) {
      expect(expectedTimeoutFailure(this.test.title)).to.be.equal(wasTimeout)
    } else {
      const reindexChainCommand: AdminReindexChainCommand = {
        command: PROTOCOL_COMMANDS.REINDEX_CHAIN,
        node: config.keys.peerId.toString(),
        chainId: DEVELOPMENT_CHAIN_ID,
        expiryTimestamp,
        signature
      }
      const reindexChainHandler = new ReindexChainHandler(oceanNode)
      const validationResponse = await reindexChainHandler.validate(reindexChainCommand)
      assert(validationResponse, 'invalid reindex chain validation response')
      assert(
        validationResponse.valid === true,
        'validation for reindex chain command failed'
      )

      let reindexResult: any = null
      INDEXER_CRAWLING_EVENT_EMITTER.addListener(
        INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN,
        (data) => {
          // {result: true/false}
          assert(typeof data.result === 'boolean', 'expected a boolean value')
          reindexResult = data.result as boolean
        }
      )
      const handlerResponse = await reindexChainHandler.handle(reindexChainCommand)
      assert(handlerResponse, 'handler resp does not exist')
      assert(handlerResponse.status.httpStatus === 200, 'incorrect http status')
      const responseJob: JobStatus = await streamToObject(
        handlerResponse.stream as Readable
      )

      assert(
        indexer.getJobsPool(responseJob.jobId).length === 1,
        'job id not found in pool'
      )
      assert(
        responseJob.command === PROTOCOL_COMMANDS.REINDEX_CHAIN,
        'command not expected'
      )
      assert(responseJob.jobId.includes(PROTOCOL_COMMANDS.REINDEX_CHAIN))
      assert(responseJob.timestamp <= new Date().getTime().toString())
      assert(
        responseJob.hash === create256Hash(DEVELOPMENT_CHAIN_ID.toString()),
        'wrong job hash'
      )

      // give it a little time to respond with the event
      await sleep(getCrawlingInterval() * 2)
      if (reindexResult !== null) {
        assert(typeof reindexResult === 'boolean', 'expected a boolean value')
      }
    }
  })

  it('should test commands for start/stop threads', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    // -----------------------------------------
    // IndexingThreadHandler
    const indexingHandler: IndexingThreadHandler = CoreHandlersRegistry.getInstance(
      oceanNode
    ).getHandler(PROTOCOL_COMMANDS.HANDLE_INDEXING_THREAD) as IndexingThreadHandler

    const signature = await getSignature(expiryTimestamp.toString())
    const indexingStartCommand: StartStopIndexingCommand = {
      command: PROTOCOL_COMMANDS.HANDLE_INDEXING_THREAD,
      action: IndexingCommand.START_THREAD,
      expiryTimestamp,
      signature
    }
    expect((await indexingHandler.validate(indexingStartCommand)).valid).to.be.equal(true) // OK

    const indexingStopCommand: StartStopIndexingCommand = {
      command: PROTOCOL_COMMANDS.HANDLE_INDEXING_THREAD,
      action: IndexingCommand.STOP_THREAD,
      expiryTimestamp: 10,
      signature
    }
    expect((await indexingHandler.validate(indexingStopCommand)).valid).to.be.equal(false) // NOK

    // OK now
    indexingStopCommand.expiryTimestamp = expiryTimestamp
    indexingStopCommand.chainId = 8996
    expect((await indexingHandler.validate(indexingStopCommand)).valid).to.be.equal(true) // OK

    // should exist a running thread for this network atm
    const response = await indexingHandler.handle(indexingStopCommand)
    assert(response.stream, 'Failed to get stream when stoping thread')
    expect(response.status.httpStatus).to.be.equal(200)

    await sleep(5000)

    // restart it again after 5 secs
    indexingStartCommand.chainId = 8996
    const responseStart = await indexingHandler.handle(indexingStartCommand)
    assert(responseStart.stream, 'Failed to get stream when starting thread')
    expect(responseStart.status.httpStatus).to.be.equal(200)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
    INDEXER_CRAWLING_EVENT_EMITTER.removeAllListeners()
    indexer.stopAllThreads()
  })
})
