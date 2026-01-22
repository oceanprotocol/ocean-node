/**
 * Ocean Node Indexer - Main Module
 *
 * This module implements a multi-chain blockchain event indexer using a
 * single-threaded, non-blocking architecture optimized for I/O-bound operations.
 *
 * Architecture:
 * - Uses ChainIndexer instances (one per blockchain) that run concurrently
 * - All operations are async/await, leveraging Node.js event loop for concurrency
 * - No worker threads - optimal for I/O-bound workloads (RPC calls, DB queries)
 * - Event-driven communication via EventEmitter
 *
 * Key Components:
 * - OceanIndexer: Main orchestrator managing multiple ChainIndexer instances
 * - ChainIndexer: Per-chain indexer running async indexing loop
 * - Event Processors: Handle specific blockchain event types
 *
 * @module Indexer
 * @see {@link docs/indexer.md} for detailed documentation
 */

import EventEmitter from 'node:events'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { ChainIndexer, ReindexTask } from './ChainIndexer.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import {
  Blockchain,
  EVENTS,
  getConfiguration,
  INDEXER_CRAWLING_EVENTS,
  PROTOCOL_COMMANDS
} from '../../utils/index.js'
import { CommandStatus, JobStatus } from '../../@types/commands.js'
import { buildJobIdentifier, getDeployedContractBlock } from './utils.js'
import { create256Hash } from '../../utils/crypt.js'
import { isReachableConnection } from '../../utils/database.js'
import { sleep } from '../../utils/util.js'
import { isReindexingNeeded } from './version.js'

/**
 * Event emitter for DDO (Data Descriptor Object) events
 * External components subscribe to this for asset lifecycle events
 */
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()

/**
 * Event emitter for internal indexer events
 * Used for communication between ChainIndexer instances and OceanIndexer
 */
export const INDEXER_CRAWLING_EVENT_EMITTER = new EventEmitter()

let INDEXING_QUEUE: ReindexTask[] = []
// job queue for admin commands or other commands not immediately available
const JOBS_QUEUE: JobStatus[] = []

const MAX_CRAWL_RETRIES = 10
let numCrawlAttempts = 0

/**
 * OceanIndexer - Multi-chain blockchain event indexer
 *
 * Manages indexing across multiple blockchain networks using a single-threaded,
 * non-blocking architecture. Each chain is monitored by a ChainIndexer instance
 * that runs concurrently via Node.js event loop.
 *
 * Features:
 * - Concurrent multi-chain indexing without worker threads
 * - Event-driven communication via EventEmitter
 * - Automatic version-based reindexing
 * - Admin commands for chain management
 * - Graceful shutdown support
 *
 * @see ChainIndexer for per-chain indexing implementation
 * @see docs/indexer.md for detailed architecture documentation
 */
export class OceanIndexer {
  private db: Database
  private networks: RPCS
  private supportedChains: string[]
  private indexers: Map<number, ChainIndexer> = new Map()
  private MIN_REQUIRED_VERSION = '0.2.2'

  constructor(db: Database, supportedNetworks: RPCS) {
    this.db = db
    this.networks = supportedNetworks
    this.supportedChains = Object.keys(supportedNetworks)
    INDEXING_QUEUE = []
    this.startThreads()
  }

  public getSupportedNetworks(): RPCS {
    return this.networks
  }

  public getDatabase(): Database {
    return this.db
  }

  public getSupportedNetwork(chainId: number): SupportedNetwork {
    let network: SupportedNetwork
    // the following will us to quickly define rpc
    //  export RPCS="{ \"8996\": \"http://127.0.0.1:8545\"}
    if (typeof this.networks[chainId] === 'string') {
      network = {
        chainId,
        network: String(chainId),
        rpc: String(this.networks[chainId])
      }
    } else {
      network = this.networks[chainId]
    }
    // set some defaults if needed
    if (!network.chunkSize) network.chunkSize = 1
    return network
  }

  // stops all indexers
  public async stopAllThreads(): Promise<boolean> {
    const stopPromises: Promise<void>[] = []
    for (const chainID of this.supportedChains) {
      const promise = this.stopThread(Number(chainID))
      if (promise) {
        stopPromises.push(promise)
      }
    }
    await Promise.allSettled(stopPromises)
    return stopPromises.length === this.supportedChains.length
  }

  // stops indexing for a specific chain
  public async stopThread(chainID: number): Promise<void> {
    const indexer = this.indexers.get(chainID)
    if (indexer) {
      await indexer.stop()
      this.indexers.delete(chainID)
      INDEXER_LOGGER.logMessage(`Stopped indexer for chain ${chainID}`)
    } else {
      INDEXER_LOGGER.error('Unable to find running indexer for chain ' + chainID)
    }
  }

  // it does not start crawling until the network connectin is ready
  async startCrawler(blockchain: Blockchain): Promise<boolean> {
    if ((await blockchain.isNetworkReady()).ready) {
      return true
    } else {
      // try other RPCS if any available (otherwise will just retry the same RPC)
      const connectionStatus = await blockchain.tryFallbackRPCs()
      if (connectionStatus.ready || (await blockchain.isNetworkReady()).ready) {
        return true
      }
    }
    return false
  }

  async retryCrawlerWithDelay(
    blockchain: Blockchain,
    interval: number = 5000 // in milliseconds, default 5 secs
  ): Promise<boolean> {
    try {
      const retryInterval = Math.max(blockchain.getKnownRPCs().length * 3000, interval) // give 2 secs per each one
      // try
      const result = await this.startCrawler(blockchain)
      const dbActive = this.getDatabase()
      if (!dbActive || !(await isReachableConnection(dbActive.getConfig().url))) {
        INDEXER_LOGGER.error(`Giving up start crawling. DB is not online!`)
        return false
      }
      if (result) {
        INDEXER_LOGGER.info('Blockchain connection succeffully established!')
        // processNetworkData(blockchain.getProvider(), blockchain.getSigner())
        return true
      } else {
        INDEXER_LOGGER.warn(
          `Blockchain connection is not established, retrying again in ${
            retryInterval / 1000
          } secs....`
        )
        numCrawlAttempts++
        if (numCrawlAttempts <= MAX_CRAWL_RETRIES) {
          // delay the next call
          await sleep(retryInterval)
          // recursively call the same func
          return this.retryCrawlerWithDelay(blockchain, retryInterval)
        } else {
          INDEXER_LOGGER.error(
            `Giving up start crawling after ${MAX_CRAWL_RETRIES} retries.`
          )
          return false
        }
      }
    } catch (err) {
      INDEXER_LOGGER.error(`Error starting crawler: ${err.message}`)
      return false
    }
  }

  // starts indexing for a specific chain
  public async startThread(chainID: number): Promise<ChainIndexer | null> {
    // If an indexer is already running, stop it first
    const existingIndexer = this.indexers.get(chainID)
    if (existingIndexer && existingIndexer.isIndexing()) {
      INDEXER_LOGGER.logMessage(
        `Stopping existing indexer for chain ${chainID} before starting new one...`
      )
      await existingIndexer.stop()
      this.indexers.delete(chainID)
      await sleep(1000) // Give the indexer time to stop
    }

    const rpcDetails: SupportedNetwork = this.getSupportedNetwork(chainID)
    if (!rpcDetails) {
      INDEXER_LOGGER.error(
        'Unable to start (unsupported network) indexer for chain: ' + chainID
      )
      return null
    }

    const config = await getConfiguration()
    const blockchain = new Blockchain(
      rpcDetails.rpc,
      rpcDetails.chainId,
      config,
      rpcDetails.fallbackRPCs
    )
    const canStartIndexer = await this.retryCrawlerWithDelay(blockchain)
    if (!canStartIndexer) {
      INDEXER_LOGGER.error(`Cannot start indexer. Check DB and RPC connections!`)
      return null
    }

    // Create new ChainIndexer instance
    const indexer = new ChainIndexer(rpcDetails, INDEXER_CRAWLING_EVENT_EMITTER)

    INDEXER_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_INFO,
      `Starting indexer for network ${rpcDetails.network} (chainId: ${chainID})`,
      true
    )

    // Start indexing (runs in background, doesn't block)
    await indexer.start()

    this.indexers.set(chainID, indexer)
    return indexer
  }

  // Start all chain indexers
  public async startThreads(): Promise<boolean> {
    await this.checkAndTriggerReindexing()

    // Setup event listeners for all chains (they all use the same event emitter)
    this.setupEventListeners()

    // Start all indexers - they will run concurrently via async/await
    let count = 0
    for (const network of this.supportedChains) {
      const chainId = parseInt(network)
      const indexer = await this.startThread(chainId)
      if (indexer) {
        count++
      }
    }

    return count === this.supportedChains.length
  }

  private setupEventListeners() {
    // Listen to metadata events from any chain indexer
    const metadataEvents = [
      EVENTS.METADATA_CREATED,
      EVENTS.METADATA_UPDATED,
      EVENTS.METADATA_STATE,
      EVENTS.ORDER_STARTED,
      EVENTS.ORDER_REUSED,
      EVENTS.DISPENSER_ACTIVATED,
      EVENTS.DISPENSER_DEACTIVATED,
      EVENTS.EXCHANGE_ACTIVATED,
      EVENTS.EXCHANGE_DEACTIVATED,
      EVENTS.EXCHANGE_RATE_CHANGED
    ]

    metadataEvents.forEach((eventType) => {
      INDEXER_CRAWLING_EVENT_EMITTER.on(eventType, async (event: any) => {
        try {
          if (!event.data) {
            INDEXER_LOGGER.log(
              LOG_LEVELS_STR.LEVEL_ERROR,
              `Missing event data (ddo) for ${eventType}. Something is wrong!`,
              true
            )
            return
          }

          INDEXER_LOGGER.logMessage(
            `Emitting "${eventType}" for DDO: ${event.data.id} from network: ${event.chainId}`
          )
          await Promise.resolve(INDEXER_DDO_EVENT_EMITTER.emit(eventType, event.data.id))
        } catch (err) {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Event handler failed for ${eventType}: ${err?.message ?? err}`,
            true
          )
        }
      })
    })

    // Listen to reindex queue pop events
    INDEXER_CRAWLING_EVENT_EMITTER.on(
      INDEXER_CRAWLING_EVENTS.REINDEX_QUEUE_POP,
      (event: any) => {
        try {
          INDEXING_QUEUE = INDEXING_QUEUE.filter(
            (task) => task.txId !== event.txId && task.chainId !== event.chainId
          )
          this.updateJobStatus(
            PROTOCOL_COMMANDS.REINDEX_TX,
            create256Hash([event.chainId, event.txId].join('')),
            CommandStatus.SUCCESS
          )
        } catch (err) {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Reindex queue pop handler failed: ${err?.message ?? err}`,
            true
          )
        }
      }
    )

    // Listen to reindex chain events
    INDEXER_CRAWLING_EVENT_EMITTER.on(
      INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN,
      (event: any) => {
        try {
          this.updateJobStatus(
            PROTOCOL_COMMANDS.REINDEX_CHAIN,
            create256Hash([event.chainId].join('')),
            event.result ? CommandStatus.SUCCESS : CommandStatus.FAILURE
          )
        } catch (err) {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Reindex chain handler failed: ${err?.message ?? err}`,
            true
          )
        }
      }
    )

    // Listen to crawling started events
    INDEXER_CRAWLING_EVENT_EMITTER.on(
      INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED,
      (event: any) => {
        INDEXER_LOGGER.logMessage(
          `Crawling started for chain ${event.chainId} from block ${event.startBlock}`
        )
      }
    )
  }

  public addReindexTask(reindexTask: ReindexTask): JobStatus | null {
    const indexer = this.indexers.get(reindexTask.chainId)
    if (indexer) {
      const job = buildJobIdentifier(PROTOCOL_COMMANDS.REINDEX_TX, [
        reindexTask.chainId.toString(),
        reindexTask.txId
      ])
      indexer.addReindexTask(reindexTask)
      INDEXING_QUEUE.push(reindexTask)
      this.addJob(job)
      return job
    }
    INDEXER_LOGGER.error(`No indexer found for chain ${reindexTask.chainId}`)
    return null
  }

  public async resetCrawling(
    chainId: number,
    blockNumber?: number
  ): Promise<JobStatus | null> {
    let indexer = this.indexers.get(chainId)

    // If not running or not found, start it first
    if (!indexer || !indexer.isIndexing()) {
      INDEXER_LOGGER.warn(
        'Indexer for chain: ' + chainId + ' is not running, starting first...'
      )
      indexer = await this.startThread(chainId)
      if (!indexer) {
        INDEXER_LOGGER.error('Could not start indexer, aborting...')
        return null
      }
    }

    if (indexer) {
      const job = buildJobIdentifier(PROTOCOL_COMMANDS.REINDEX_CHAIN, [
        chainId.toString()
      ])
      indexer.triggerReindexChain(blockNumber)
      this.addJob(job)
      return job
    } else {
      INDEXER_LOGGER.error(`Could not find indexer for chain ${chainId}, aborting...`)
    }
    return null
  }

  public getIndexingQueue(): ReindexTask[] {
    return INDEXING_QUEUE.slice()
  }

  public getJobsPool(jobId?: string): JobStatus[] {
    if (jobId) {
      const pos = -1
      const result = this.filterJobs(jobId)
      // if it finished, then we can remove it from the list of jobs
      if (
        result.jobsResult.length === 1 &&
        [CommandStatus.FAILURE, CommandStatus.SUCCESS].includes(
          result.jobsResult[0].status
        )
      ) {
        JOBS_QUEUE.splice(pos, 1)
      }
      return result.jobsResult
    }
    return JOBS_QUEUE.slice()
  }

  // when we add a new job, we change the status from DELIVERED to PENDING if still running after a couple secs
  public addJob(jobInfo: JobStatus) {
    JOBS_QUEUE.push(jobInfo)
    setTimeout(() => {
      const result = this.filterJobs(jobInfo.jobId)
      if (
        result.jobsResult.length === 1 &&
        result.jobsResult[0].status === CommandStatus.DELIVERED
      ) {
        this.updateJobStatus(jobInfo.command, jobInfo.hash, CommandStatus.PENDING)
      }
    }, 2000)
  }

  // filter jobs by job id, return the position of the job on the queue as well
  private filterJobs(jobId: string): { position: number; jobsResult: JobStatus[] } {
    let pos = -1
    const result = JOBS_QUEUE.filter((job: JobStatus, index: number) => {
      if (job.jobId === jobId) {
        pos = index
        return true
      }
      return false
    })
    return { position: pos, jobsResult: result }
  }

  // update the job status, given the command and the hash
  private updateJobStatus(command: string, hash: string, newStatus: CommandStatus) {
    if (JOBS_QUEUE.length > 0) {
      for (let i = JOBS_QUEUE.length - 1; i >= 0; i--) {
        const job = JOBS_QUEUE[i]
        // make sure we always pick the correct one
        if (job.command === command && hash === job.hash) {
          job.status = newStatus
        }
      }
    }
  }

  /**
   * Checks if reindexing is needed and triggers it for all chains
   */
  public async checkAndTriggerReindexing(): Promise<void> {
    const currentVersion = process.env.npm_package_version
    const dbActive = this.getDatabase()
    if (!dbActive || !(await isReachableConnection(dbActive.getConfig().url))) {
      INDEXER_LOGGER.error(`Giving up reindexing. DB is not online!`)
      return
    }
    const dbVersion = await dbActive.sqliteConfig?.retrieveValue()
    INDEXER_LOGGER.info(
      `Node version check: Current=${currentVersion}, DB=${
        dbVersion || 'not set'
      }, Min Required=${this.MIN_REQUIRED_VERSION}`
    )

    if (isReindexingNeeded(currentVersion, dbVersion.value, this.MIN_REQUIRED_VERSION)) {
      INDEXER_LOGGER.info(
        `Reindexing needed: DB version ${
          dbVersion.value || 'not set'
        } is older than minimum required ${this.MIN_REQUIRED_VERSION}`
      )

      // Reindex all chains by directly setting last indexed block to deployment block
      for (const chainID of this.supportedChains) {
        const chainIdNum = Number(chainID)

        INDEXER_LOGGER.info(
          `Triggering reindexing for chain ${chainIdNum} by resetting to block null`
        )

        try {
          // First delete all assets from this chain
          const numDeleted = await dbActive.ddo.deleteAllAssetsFromChain(chainIdNum)
          INDEXER_LOGGER.info(`Deleted ${numDeleted} assets from chain ${chainIdNum}`)

          // Update database directly by resetting last indexed block
          const contractDeploymentBlock = getDeployedContractBlock(chainIdNum)
          const result = await dbActive.indexer.update(
            chainIdNum,
            contractDeploymentBlock
          )

          if (!result) {
            INDEXER_LOGGER.error(
              `Reindex chain job for ${chainIdNum} failed. Please retry reindexChain command manually for this chain.`
            )
          } else {
            INDEXER_LOGGER.info(
              `Successfully reset indexing for chain ${chainIdNum} to block null`
            )
          }
        } catch (error) {
          INDEXER_LOGGER.error(
            `Error resetting index for chain ${chainIdNum}: ${error.message}. Please retry reindexChain command manually.`
          )
        }
      }
      await dbActive.sqliteConfig?.createOrUpdateConfig('version', currentVersion)
      INDEXER_LOGGER.info(`Updated node version in database to ${currentVersion}`)
    } else {
      INDEXER_LOGGER.info('No reindexing needed based on version check')
    }
  }
}
