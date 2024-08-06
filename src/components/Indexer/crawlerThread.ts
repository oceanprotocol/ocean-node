import { parentPort, workerData } from 'worker_threads'
import {
  getCrawlingInterval,
  getDeployedContractBlock,
  getNetworkHeight,
  processBlocks,
  processChunkLogs,
  retrieveChunkEvents
} from './utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { BlocksEvents, SupportedNetwork } from '../../@types/blockchain.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { isDefined, sleep } from '../../utils/util.js'
import { EVENTS, INDEXER_CRAWLING_EVENTS, INDEXER_MESSAGES } from '../../utils/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { getDatabase } from '../../utils/database.js'
import { JsonRpcApiProvider, Log, Signer } from 'ethers'
import { DEVELOPMENT_CHAIN_ID } from '../../utils/address.js'

export interface ReindexTask {
  txId: string
  chainId: number
  eventIndex?: number
}

let REINDEX_BLOCK: number = null
const REINDEX_QUEUE: ReindexTask[] = []

let stoppedCrawling: boolean = false
let startedCrawling: boolean = false
interface ThreadData {
  rpcDetails: SupportedNetwork
}

const { rpcDetails } = workerData as ThreadData

export async function updateLastIndexedBlockNumber(block: number): Promise<number> {
  try {
    const { indexer } = await getDatabase()
    const updatedIndex = await indexer.update(rpcDetails.chainId, block)
    INDEXER_LOGGER.logMessage(
      `New last indexed block : ${updatedIndex.lastIndexedBlock}`,
      true
    )
    return updatedIndex.lastIndexedBlock
  } catch (err) {
    INDEXER_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Error updating last indexed block ${err.message}`,
      true
    )
    return -1
  }
}

async function getLastIndexedBlock(): Promise<number> {
  const { indexer } = await getDatabase()
  try {
    const networkDetails = await indexer.retrieve(rpcDetails.chainId)
    return networkDetails?.lastIndexedBlock
  } catch (err) {
    INDEXER_LOGGER.error(`Error retrieving last indexed block: ${err}`)
    return null
  }
}

async function deleteAllAssetsFromChain(): Promise<number> {
  const { ddo } = await getDatabase()
  try {
    const numDeleted = await ddo.deleteAllAssetsFromChain(rpcDetails.chainId)
    INDEXER_LOGGER.logMessage(`${numDeleted} Assets were successfully deleted.`)
    return numDeleted
  } catch (err) {
    INDEXER_LOGGER.error(`Error deleting all assets: ${err}`)
    return -1
  }
}

export async function processNetworkData(
  provider: JsonRpcApiProvider,
  signer: Signer
): Promise<void> {
  stoppedCrawling = startedCrawling = false
  let contractDeploymentBlock = getDeployedContractBlock(rpcDetails.chainId)
  if (!isDefined(contractDeploymentBlock) && !isDefined(await getLastIndexedBlock())) {
    if (rpcDetails.chainId === DEVELOPMENT_CHAIN_ID) {
      rpcDetails.startBlock = contractDeploymentBlock = 0
      INDEXER_LOGGER.warn(
        'Cannot get block info for local network, starting from block 0'
      )
    } else {
      INDEXER_LOGGER.logMessage(
        `chain: ${rpcDetails.chainId} Both deployed block and last indexed block are null/undefined. Cannot proceed further on this chain`,
        true
      )

      return null
    }
  }
  // if we defined a valid startBlock use it, oterwise start from deployed one

  const crawlingStartBlock =
    rpcDetails.startBlock && rpcDetails.startBlock > contractDeploymentBlock
      ? rpcDetails.startBlock
      : contractDeploymentBlock

  // we can override the default value of 30 secs, by setting process.env.INDEXER_INTERVAL
  const interval = getCrawlingInterval()
  let { chunkSize } = rpcDetails
  let lockProccessing = false

  while (true) {
    let currentBlock
    if (!lockProccessing) {
      lockProccessing = true
      const lastIndexedBlock = await getLastIndexedBlock()
      const networkHeight = await getNetworkHeight(provider)
      const startBlock =
        lastIndexedBlock && lastIndexedBlock > crawlingStartBlock
          ? lastIndexedBlock
          : crawlingStartBlock

      INDEXER_LOGGER.logMessage(
        `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`,
        true
      )
      if (networkHeight > startBlock) {
        // emit an one shot event when we actually start the crawling process
        if (!startedCrawling) {
          startedCrawling = true
          parentPort.postMessage({
            method: INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED,
            data: { startBlock, networkHeight, contractDeploymentBlock }
          })
        }
        const remainingBlocks = networkHeight - startBlock
        const blocksToProcess = Math.min(chunkSize, remainingBlocks)
        INDEXER_LOGGER.logMessage(
          `network: ${rpcDetails.network} processing ${blocksToProcess} blocks ...`
        )
        let chunkEvents: Log[] = []
        try {
          chunkEvents = await retrieveChunkEvents(
            signer,
            provider,
            rpcDetails.chainId,
            startBlock,
            blocksToProcess
          )
        } catch (error) {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Get events for network: ${rpcDetails.network} failure: ${error.message} `,
            true
          )
          chunkSize = Math.floor(chunkSize / 2) < 1 ? 1 : Math.floor(chunkSize / 2)
          INDEXER_LOGGER.logMessage(
            `network: ${rpcDetails.network} Reducing chunk size  ${chunkSize} `,
            true
          )
        }
        try {
          const processedBlocks = await processBlocks(
            chunkEvents,
            signer,
            provider,
            rpcDetails.chainId,
            startBlock,
            blocksToProcess
          )
          currentBlock = await updateLastIndexedBlockNumber(processedBlocks.lastBlock)
          // we can't just update currentBlock to processedBlocks.lastBlock if the DB action failed
          if (currentBlock < 0 && lastIndexedBlock !== null) {
            currentBlock = lastIndexedBlock
          }
          checkNewlyIndexedAssets(processedBlocks.foundEvents)
          chunkSize = chunkSize !== 1 ? chunkSize : rpcDetails.chunkSize
        } catch (error) {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Processing event from network failed network: ${rpcDetails.network} Error: ${error.message} `,
            true
          )
          await updateLastIndexedBlockNumber(startBlock + blocksToProcess)
        }
      }
      await processReindex(provider, signer, rpcDetails.chainId)
      lockProccessing = false
    } else {
      INDEXER_LOGGER.logMessage(
        `Processing already in progress for network ${rpcDetails.network}, waiting until finishing the current processing ...`,
        true
      )
    }
    await sleep(interval)
    // reindex chain command called
    if (REINDEX_BLOCK && !lockProccessing) {
      // either "true" for success or "false" otherwise
      const result = await reindexChain(currentBlock)
      // get all reindex commands
      // TODO (check that we do not receive multiple commands for same reindex before previous finishes)
      parentPort.postMessage({
        method: INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN,
        data: { result, chainId: rpcDetails.chainId }
      })
    }

    if (stoppedCrawling) {
      INDEXER_LOGGER.logMessage('Exiting thread...')
      startedCrawling = false
      break
    }
  }
}

async function reindexChain(currentBlock: number): Promise<boolean> {
  const block = await updateLastIndexedBlockNumber(REINDEX_BLOCK)
  if (block !== -1) {
    REINDEX_BLOCK = null
    const res = await deleteAllAssetsFromChain()
    if (res === -1) {
      await updateLastIndexedBlockNumber(currentBlock)
    }
    return true
  } else {
    // Set the reindex block to null -> force admin to trigger again the command until
    // we have a notification from worker thread to parent thread #414.
    INDEXER_LOGGER.error(`Block could not be reset. Continue indexing normally...`)
    REINDEX_BLOCK = null
    return false
  }
}

async function processReindex(
  provider: JsonRpcApiProvider,
  signer: Signer,
  chainId: number
): Promise<void> {
  while (REINDEX_QUEUE.length > 0) {
    const reindexTask = REINDEX_QUEUE.pop()
    try {
      const receipt = await provider.getTransactionReceipt(reindexTask.txId)
      if (receipt) {
        const log = receipt.logs[reindexTask.eventIndex]
        const logs = log ? [log] : receipt.logs
        await processChunkLogs(logs, signer, provider, chainId)
        // send message to clear from the 'top' queue
        parentPort.postMessage({
          method: INDEXER_CRAWLING_EVENTS.REINDEX_QUEUE_POP,
          data: { reindexTask }
        })
      } else {
        // put it back as it failed
        REINDEX_QUEUE.push(reindexTask)
      }
    } catch (error) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `REINDEX Error: ${error.message} `,
        true
      )
    }
  }
}

export function checkNewlyIndexedAssets(events: BlocksEvents): void {
  const eventKeys = Object.keys(events)
  eventKeys.forEach((eventType) => {
    // will emit messages for all these events
    if (
      [
        EVENTS.METADATA_CREATED,
        EVENTS.METADATA_UPDATED,
        EVENTS.METADATA_STATE,
        EVENTS.ORDER_STARTED,
        EVENTS.ORDER_REUSED
      ].includes(eventType)
    ) {
      parentPort.postMessage({
        method: eventType,
        network: rpcDetails.chainId,
        data: events[eventType]
      })
    }
  })
}

async function retryCrawlerWithDelay(
  blockchain: Blockchain,
  interval: number = 5000 // in milliseconds, default 5 secs
): Promise<boolean> {
  try {
    const retryInterval = Math.max(blockchain.getKnownRPCs().length * 3000, interval) // give 2 secs per each one
    // try
    const result = await startCrawler(blockchain)
    if (result) {
      INDEXER_LOGGER.info('Blockchain connection succeffully established!')
      processNetworkData(blockchain.getProvider(), blockchain.getSigner())
      return true
    } else {
      INDEXER_LOGGER.warn(
        `Blockchain connection is not established, retrying again in ${
          retryInterval / 1000
        } secs....`
      )
      // delay the next call
      await sleep(retryInterval)
      // recursively call the same func
      return retryCrawlerWithDelay(blockchain, retryInterval)
    }
  } catch (err) {
    INDEXER_LOGGER.error(`Error starting crawler: ${err.message}`)
    return false
  }
}

// it does not start crawling until the network connectin is ready
async function startCrawler(blockchain: Blockchain): Promise<boolean> {
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

parentPort.on('message', (message) => {
  if (message.method === INDEXER_MESSAGES.START_CRAWLING) {
    // start indexing the chain
    const blockchain = new Blockchain(
      rpcDetails.rpc,
      rpcDetails.network,
      rpcDetails.chainId,
      rpcDetails.fallbackRPCs
    )
    return retryCrawlerWithDelay(blockchain)
  } else if (message.method === INDEXER_MESSAGES.REINDEX_TX) {
    // reindex a specific transaction

    REINDEX_QUEUE.push(message.data.reindexTask)
  } else if (message.method === INDEXER_MESSAGES.REINDEX_CHAIN) {
    // reindex a specific chain
    const deployBlock = getDeployedContractBlock(rpcDetails.chainId)
    REINDEX_BLOCK =
      rpcDetails.startBlock && rpcDetails.startBlock >= deployBlock
        ? rpcDetails.startBlock
        : deployBlock
  } else if (message.method === INDEXER_MESSAGES.STOP_CRAWLING) {
    // stop indexing the chain
    stoppedCrawling = true
    INDEXER_LOGGER.warn('Stopping crawler thread once current run finishes...')
  }
})
