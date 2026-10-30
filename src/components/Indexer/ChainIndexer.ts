import EventEmitter from 'node:events'
import { FallbackProvider, Log, Signer } from 'ethers'
import { SupportedNetwork } from '../../@types/blockchain.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { isDefined, sleep } from '../../utils/util.js'
import { EVENTS, INDEXER_CRAWLING_EVENTS } from '../../utils/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { errorSummary } from '../../utils/logging/redact.js'
import { DEVELOPMENT_CHAIN_ID } from '../../utils/address.js'
import { processBlocks, processChunkLogs } from './processor.js'
import { Blockchain } from '../../utils/blockchain.js'
import {
  getCrawlingInterval,
  getDeployedContractBlock,
  getNetworkHeight,
  isProviderError,
  retrieveChunkEvents
} from './utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Database } from '../database/index.js'

// consecutive loop failures after which a recovery is logged at info and the throttle reset
const FAILURE_ESCALATION_THRESHOLD = 5

export interface ReindexTask {
  txId: string
  chainId: number
  eventIndex?: number
}

/**
 * ChainIndexer - Handles blockchain indexing for a single chain
 * Runs in the main thread using async/await for non-blocking concurrent execution
 */
export class ChainIndexer {
  private config: OceanNodeConfig
  private rpcDetails: SupportedNetwork
  private stopSignal: boolean = false
  private isRunning: boolean = false
  private reindexBlock: number | null = null
  private reindexQueue: ReindexTask[] = []
  private eventEmitter: EventEmitter
  private blockchain: Blockchain
  private db: Database
  private consecutiveFailures: number = 0

  constructor(
    blockchain: Blockchain,
    rpcDetails: SupportedNetwork,
    eventEmitter: EventEmitter,
    database: Database,
    _config: OceanNodeConfig
  ) {
    this.blockchain = blockchain
    this.eventEmitter = eventEmitter
    this.rpcDetails = rpcDetails
    this.db = database
    this.config = _config
  }

  /**
   * Start indexing - returns immediately, runs in background
   */
  // eslint-disable-next-line require-await
  async start(): Promise<void> {
    if (this.isRunning) {
      INDEXER_LOGGER.warn(
        `Chain ${this.blockchain.getSupportedChain()} is already running`
      )
      return
    }

    this.stopSignal = false
    this.isRunning = true

    // Start crawling but DON'T await - let it run in background
    this.indexLoop().catch((err) => {
      INDEXER_LOGGER.error(
        `Indexer error for chain ${this.blockchain.getSupportedChain()}: ${err?.message ?? err}`
      )
      this.isRunning = false
    })
  }

  /**
   * Stop indexing gracefully
   */
  async stop(): Promise<void> {
    this.stopSignal = true
    INDEXER_LOGGER.debug(
      `Stopping indexer for chain ${this.blockchain.getSupportedChain()}, waiting for graceful shutdown...`
    )

    // Wait for graceful shutdown
    while (this.isRunning) {
      await sleep(100)
    }

    INDEXER_LOGGER.info(`Chain ${this.blockchain.getSupportedChain()}: indexer stopped`)
  }

  /**
   * Check if the indexer is currently running
   */
  isIndexing(): boolean {
    return this.isRunning
  }

  /**
   * Add a reindex task for a specific transaction
   */
  addReindexTask(task: ReindexTask): void {
    this.reindexQueue.push(task)
    INDEXER_LOGGER.info(`Added reindex task for tx ${task.txId} on chain ${task.chainId}`)
  }

  /**
   * Trigger a full chain reindex from a specific block
   */
  triggerReindexChain(blockNumber?: number): void {
    const deployBlock = getDeployedContractBlock(this.blockchain.getSupportedChain())
    let targetBlock =
      this.rpcDetails.startBlock && this.rpcDetails.startBlock >= deployBlock
        ? this.rpcDetails.startBlock
        : deployBlock

    // Use specific block if provided and valid
    if (blockNumber && !isNaN(blockNumber) && blockNumber > deployBlock) {
      targetBlock = blockNumber
    }

    this.reindexBlock = targetBlock
    INDEXER_LOGGER.info(
      `Triggered reindex for chain ${this.blockchain.getSupportedChain()} from block ${targetBlock}`
    )
  }

  /**
   * Main indexing loop - runs continuously until stopped
   */
  private async indexLoop(): Promise<void> {
    let contractDeploymentBlock = getDeployedContractBlock(
      this.blockchain.getSupportedChain()
    )
    const isLocalChain = this.blockchain.getSupportedChain() === DEVELOPMENT_CHAIN_ID

    if (isLocalChain && !isDefined(contractDeploymentBlock)) {
      this.rpcDetails.startBlock = contractDeploymentBlock = 0
      INDEXER_LOGGER.warn(
        'Cannot get block info for local network, starting from block 0'
      )
    } else if (
      !isLocalChain &&
      !isDefined(contractDeploymentBlock) &&
      !isDefined(await this.getLastIndexedBlock())
    ) {
      INDEXER_LOGGER.error(
        `Chain ${this.blockchain.getSupportedChain()}: Both deployed block and last indexed block are null/undefined. Cannot proceed.`
      )
      this.isRunning = false
      return
    }

    const crawlingStartBlock =
      this.rpcDetails.startBlock && this.rpcDetails.startBlock > contractDeploymentBlock
        ? this.rpcDetails.startBlock
        : contractDeploymentBlock

    INDEXER_LOGGER.info(
      `Chain ${this.blockchain.getSupportedChain()}: start block ${crawlingStartBlock} (deploy ${contractDeploymentBlock}, configured startBlock ${this.rpcDetails.startBlock})`
    )

    let provider = await this.blockchain.getProvider()
    let signer = await this.blockchain.getSigner()
    const interval = getCrawlingInterval()
    let chunkSize = this.rpcDetails.chunkSize || 1
    let successfulRetrievalCount = 0
    let lockProcessing = false
    let startedCrawling = false
    let currentBlock: number

    while (!this.stopSignal) {
      if (!lockProcessing) {
        lockProcessing = true
        let iterationFailed = false

        try {
          // Self-heal: if the provider was destroyed (overlapping teardown), getProvider()
          // recreates it and getSigner() rebuilds against it. When healthy, both return the
          // cached instances at negligible cost.
          provider = await this.blockchain.getProvider()
          signer = await this.blockchain.getSigner()

          const lastIndexedBlock = await this.getLastIndexedBlock()
          const networkHeight = await getNetworkHeight(provider)
          const startBlock =
            lastIndexedBlock && lastIndexedBlock > crawlingStartBlock
              ? lastIndexedBlock
              : crawlingStartBlock

          INDEXER_LOGGER.debug(
            `Indexing network '${this.rpcDetails.network}', Last indexed block: ${lastIndexedBlock}, Start block: ${startBlock}, Network height: ${networkHeight}`
          )

          if (networkHeight > startBlock) {
            // Emit one-shot event when crawling actually starts
            if (!startedCrawling) {
              startedCrawling = true
              this.eventEmitter.emit(INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED, {
                chainId: this.blockchain.getSupportedChain(),
                startBlock,
                networkHeight,
                contractDeploymentBlock
              })
            }

            const remainingBlocks = networkHeight - startBlock
            const blocksToProcess = Math.min(chunkSize, remainingBlocks)
            INDEXER_LOGGER.debug(
              `network: ${this.rpcDetails.network} processing ${blocksToProcess} blocks ...`
            )

            let chunkEvents: Log[] = []
            try {
              chunkEvents = await retrieveChunkEvents(
                signer,
                provider,
                this.blockchain.getSupportedChain(),
                startBlock,
                blocksToProcess
              )
              successfulRetrievalCount++
            } catch (error) {
              // Rethrow so the outer catch retries this range instead of advancing past it.
              if (isProviderError(error)) throw error
              chunkSize = Math.floor(chunkSize / 2) < 1 ? 1 : Math.floor(chunkSize / 2)
              successfulRetrievalCount = 0
              // throttled: the chunk size halves on every failure, so a bad RPC fails tick
              // after tick
              INDEXER_LOGGER.throttled(
                `indexer-getlogs-error-${this.blockchain.getSupportedChain()}`,
                LOG_LEVELS_STR.LEVEL_ERROR,
                `Chain ${this.blockchain.getSupportedChain()}: getLogs ${startBlock + 1}-${startBlock + blocksToProcess} failed (${errorSummary(error)}); range skipped, chunk size -> ${chunkSize}. ` +
                  'Consider that there may be an issue with your RPC provider. We recommend using private RPCs from reliable providers such as Infura or Alchemy.'
              )
            }

            try {
              const processedBlocks = await processBlocks(
                chunkEvents,
                signer,
                provider,
                this.blockchain.getSupportedChain(),
                startBlock,
                blocksToProcess,
                this.config
              )

              INDEXER_LOGGER.debug(
                `Processed ${Object.keys(processedBlocks.foundEvents).length} event types from ${chunkEvents.length} logs`
              )

              currentBlock = await this.updateLastIndexedBlockNumber(
                processedBlocks.lastBlock,
                lastIndexedBlock
              )

              // Can't update currentBlock to processedBlocks.lastBlock if DB action failed
              if (currentBlock < 0 && lastIndexedBlock !== null) {
                currentBlock = lastIndexedBlock
              }

              this.emitNewlyIndexedAssets(processedBlocks.foundEvents)

              // Revert to original chunk size after 3 successful retrievals
              if (
                successfulRetrievalCount >= 3 &&
                chunkSize < (this.rpcDetails.chunkSize || 1)
              ) {
                chunkSize = this.rpcDetails.chunkSize || 1
                successfulRetrievalCount = 0
                INDEXER_LOGGER.debug(
                  `network: ${this.rpcDetails.network} Reverting chunk size back to original ${chunkSize} after 3 successful calls`
                )
              }
            } catch (error) {
              iterationFailed = true
              this.logLoopFailure(
                `Chain ${this.blockchain.getSupportedChain()}: processing blocks from ${startBlock + 1} failed (${errorSummary(error)}), retrying`
              )
              successfulRetrievalCount = 0
              // Since something went wrong, we will not update the last indexed block
              // so we will try to process the same chunk again after some sleep
              await sleep(interval)
            }
          } else {
            await sleep(interval)
          }

          // Process reindex queue
          await this.processReindexQueue(provider, signer)

          // Handle chain reindex command
          if (this.reindexBlock !== null && !lockProcessing) {
            const networkHeight = await getNetworkHeight(provider)
            const result = await this.reindexChain(currentBlock, networkHeight)

            this.eventEmitter.emit(INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN, {
              result,
              chainId: this.blockchain.getSupportedChain()
            })
          }
          if (!iterationFailed) this.logLoopRecovered()
        } catch (error) {
          this.logLoopFailure(
            `Error in indexing loop for chain ${this.blockchain.getSupportedChain()}: ${errorSummary(error)}`
          )
          await sleep(interval)
        } finally {
          lockProcessing = false
        }
      } else {
        INDEXER_LOGGER.debug(
          `Processing already in progress for network ${this.rpcDetails.network}, waiting...`
        )
        await sleep(1000)
      }
    }

    this.isRunning = false
    INDEXER_LOGGER.debug(
      `Exiting indexer loop for chain ${this.blockchain.getSupportedChain()}`
    )
  }

  /**
   * Get the last indexed block from database
   */
  private async getLastIndexedBlock(): Promise<number | null> {
    const { indexer } = this.db
    try {
      const networkDetails = await indexer.retrieve(this.blockchain.getSupportedChain())
      if (networkDetails && networkDetails.lastIndexedBlock) {
        return networkDetails.lastIndexedBlock
      }
      INDEXER_LOGGER.debug(
        `Unable to get last indexed block from DB for chain ${this.blockchain.getSupportedChain()}`
      )
    } catch (err) {
      INDEXER_LOGGER.error(
        `Error retrieving last indexed block for chain ${this.blockchain.getSupportedChain()}: ${err}`
      )
    }
    return null
  }

  /**
   * Update the last indexed block in database
   */
  private async updateLastIndexedBlockNumber(
    block: number,
    lastKnownBlock?: number
  ): Promise<number> {
    try {
      if (isDefined(lastKnownBlock) && lastKnownBlock > block) {
        INDEXER_LOGGER.error(
          `Chain ${this.blockchain.getSupportedChain()}: Newest block number is lower than last known block, something is wrong`
        )
        return -1
      }

      const { indexer } = this.db
      const updatedIndex = await indexer.update(
        this.blockchain.getSupportedChain(),
        block
      )

      if (updatedIndex) {
        INDEXER_LOGGER.debug(
          `Chain ${this.blockchain.getSupportedChain()} - New last indexed block: ${updatedIndex.lastIndexedBlock}`
        )
        return updatedIndex.lastIndexedBlock
      } else {
        INDEXER_LOGGER.error(
          `Unable to update last indexed block to ${block} for chain ${this.blockchain.getSupportedChain()}`
        )
      }
    } catch (err) {
      INDEXER_LOGGER.error(
        `Error updating last indexed block for chain ${this.blockchain.getSupportedChain()}: ${err.message}`
      )
    }
    return -1
  }

  /**
   * Delete all assets from this chain
   */
  private async deleteAllAssetsFromChain(): Promise<number> {
    const { ddo } = this.db
    try {
      const numDeleted = await ddo.deleteAllAssetsFromChain(
        this.blockchain.getSupportedChain()
      )
      INDEXER_LOGGER.info(
        `Chain ${this.blockchain.getSupportedChain()}: deleted ${numDeleted} assets for reindex`
      )
      return numDeleted
    } catch (err) {
      INDEXER_LOGGER.error(
        `Error deleting all assets from chain ${this.blockchain.getSupportedChain()}: ${err}`
      )
      return -1
    }
  }

  /**
   * Perform a full chain reindex
   */
  private async reindexChain(
    currentBlock: number,
    networkHeight: number
  ): Promise<boolean> {
    if (this.reindexBlock > networkHeight) {
      INDEXER_LOGGER.warn(
        `Invalid reindex block! ${this.reindexBlock} is bigger than network height: ${networkHeight}. Continue indexing normally...`
      )
      this.reindexBlock = null
      return false
    }

    const block = await this.updateLastIndexedBlockNumber(this.reindexBlock)
    if (block !== -1) {
      this.reindexBlock = null
      const res = await this.deleteAllAssetsFromChain()
      if (res === -1) {
        await this.updateLastIndexedBlockNumber(currentBlock)
      }
      return true
    } else {
      INDEXER_LOGGER.error(
        `Chain ${this.blockchain.getSupportedChain()}: reindex from block ${this.reindexBlock} dropped, the last indexed block could not be reset. Continue indexing normally...`
      )
      this.reindexBlock = null
      return false
    }
  }

  /**
   * Process the reindex queue for specific transactions
   * Uses FIFO (First-In, First-Out) order via shift()
   */
  private async processReindexQueue(
    provider: FallbackProvider,
    signer: Signer
  ): Promise<void> {
    while (this.reindexQueue.length > 0) {
      const reindexTask = this.reindexQueue.shift()
      try {
        const receipt = await provider.getTransactionReceipt(reindexTask.txId)
        if (receipt) {
          const log = receipt.logs[reindexTask.eventIndex]
          const logs = log ? [log] : receipt.logs
          await processChunkLogs(
            logs,
            signer,
            provider,
            this.blockchain.getSupportedChain(),
            this.config
          )

          // Emit event to clear from parent queue
          this.eventEmitter.emit(INDEXER_CRAWLING_EVENTS.REINDEX_QUEUE_POP, {
            txId: reindexTask.txId,
            chainId: reindexTask.chainId
          })
        } else {
          INDEXER_LOGGER.warn(
            `Chain ${reindexTask.chainId}: reindex tx ${reindexTask.txId} not found`
          )
        }
      } catch (error) {
        if (isProviderError(error)) {
          // Transient provider failure: preserve the task for a later retry (do not emit
          // REINDEX_QUEUE_POP) and rethrow so the loop's outer catch holds the cursor,
          // sleeps, and re-acquires a healthy provider before retrying.
          this.reindexQueue.unshift(reindexTask)
          throw error
        }
        INDEXER_LOGGER.error(`REINDEX Error for tx ${reindexTask.txId}: ${error.message}`)
      }
    }
  }

  /**
   * Log a failed loop iteration: warn at first, error once failures keep repeating
   */
  private logLoopFailure(message: string): void {
    this.consecutiveFailures++
    const chainId = this.blockchain.getSupportedChain()
    // throttled: the loop retries every interval while the RPC/DB problem lasts
    INDEXER_LOGGER.throttled(
      `indexer-loop-error-${chainId}`,
      LOG_LEVELS_STR.LEVEL_ERROR,
      `${message} (${this.consecutiveFailures} consecutive failures)`
    )
  }

  private logLoopRecovered(): void {
    if (this.consecutiveFailures === 0) return
    const chainId = this.blockchain.getSupportedChain()
    const message = `Chain ${chainId}: indexing recovered after ${this.consecutiveFailures} consecutive failures`
    // the throttle is only reset after a long run of failures: a flapping RPC that recovers
    // between failures keeps its error rate-limited instead of logging one line per flap
    if (this.consecutiveFailures >= FAILURE_ESCALATION_THRESHOLD) {
      INDEXER_LOGGER.info(message)
      INDEXER_LOGGER.resetThrottle(`indexer-loop-error-${chainId}`)
    } else {
      INDEXER_LOGGER.debug(message)
    }
    this.consecutiveFailures = 0
  }

  /**
   * Emit events for newly indexed assets
   */
  private emitNewlyIndexedAssets(events: any): void {
    const eventKeys = Object.keys(events)
    eventKeys.forEach((eventType) => {
      if (
        [
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
        ].includes(eventType) &&
        // processors return null/undefined for events they skip
        events[eventType]
      ) {
        this.eventEmitter.emit(eventType, {
          chainId: this.blockchain.getSupportedChain(),
          data: events[eventType]
        })
      }
    })
  }
}
