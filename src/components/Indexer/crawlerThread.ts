import { parentPort, workerData } from 'worker_threads'
import {
  getCrawlingInterval,
  getDeployedContractBlock,
  getNetworkHeight,
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
import { processBlocks, processChunkLogs } from './processor.js'

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

export async function updateLastIndexedBlockNumber(
  block: number,
  lastKnownBlock?: number
): Promise<number> {
  try {
    if (isDefined(lastKnownBlock) && lastKnownBlock > block) {
      INDEXER_LOGGER.error(
        'Newest block number is lower than last known block, something is wrong'
      )
      return -1
    }
    const { indexer } = await getDatabase()
    const updatedIndex = await indexer.update(rpcDetails.chainId, block)
    if (updatedIndex) {
      INDEXER_LOGGER.logMessage(
        `New last indexed block : ${updatedIndex.lastIndexedBlock}`,
        true
      )
      return updatedIndex.lastIndexedBlock
    } else {
      INDEXER_LOGGER.error('Unable to update last indexed block to ' + block)
    }
  } catch (err) {
    INDEXER_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Error updating last indexed block ${err.message}`,
      true
    )
  }
  return -1
}

async function getLastIndexedBlock(): Promise<number> {
  const { indexer } = await getDatabase()
  try {
    const networkDetails = await indexer.retrieve(rpcDetails.chainId)
    if (networkDetails && networkDetails.lastIndexedBlock) {
      return networkDetails.lastIndexedBlock
    }
    INDEXER_LOGGER.error('Unable to get last indexed block from DB')
  } catch (err) {
    INDEXER_LOGGER.error(`Error retrieving last indexed block: ${err}`)
  }
  return null
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
  const isLocalChain = rpcDetails.chainId === DEVELOPMENT_CHAIN_ID
  if (isLocalChain && !isDefined(contractDeploymentBlock)) {
    rpcDetails.startBlock = contractDeploymentBlock = 0
    INDEXER_LOGGER.warn('Cannot get block info for local network, starting from block 0')
  } else if (
    !isLocalChain &&
    !isDefined(contractDeploymentBlock) &&
    !isDefined(await getLastIndexedBlock())
  ) {
    INDEXER_LOGGER.logMessage(
      `chain: ${rpcDetails.chainId} Both deployed block and last indexed block are null/undefined. Cannot proceed further on this chain`,
      true
    )

    return null
  }
  // if we defined a valid startBlock use it, oterwise start from deployed one

  const crawlingStartBlock =
    rpcDetails.startBlock && rpcDetails.startBlock > contractDeploymentBlock
      ? rpcDetails.startBlock
      : contractDeploymentBlock

  INDEXER_LOGGER.info(
    `Initial details: RPCS start block: ${rpcDetails.startBlock}, Contract deployment block: ${contractDeploymentBlock}, Crawling start block: ${crawlingStartBlock}`
  )

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

      INDEXER_LOGGER.info(
        `Indexing network '${rpcDetails.network}', Last indexed block: ${lastIndexedBlock}, Start block: ${startBlock}, Network height: ${networkHeight}`
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
            LOG_LEVELS_STR.LEVEL_WARN,
            `Get events for network: ${rpcDetails.network} failure: ${error.message} \n\nConsider that there may be an issue with your RPC provider. We recommend using private RPCs from reliable providers such as Infura or Alchemy.`,
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
          INDEXER_LOGGER.debug(
            `Processed ${processedBlocks.foundEvents.length} events from ${chunkEvents.length} logs`
          )
          currentBlock = await updateLastIndexedBlockNumber(
            processedBlocks.lastBlock,
            lastIndexedBlock
          )
          // we can't just update currentBlock to processedBlocks.lastBlock if the DB action failed
          if (currentBlock < 0 && lastIndexedBlock !== null) {
            currentBlock = lastIndexedBlock
          }
          checkNewlyIndexedAssets(processedBlocks.foundEvents)
          chunkSize = chunkSize !== 1 ? chunkSize : rpcDetails.chunkSize
        } catch (error) {
          INDEXER_LOGGER.error(
            `Processing event from network failed network: ${rpcDetails.network} Error: ${error.message} `
          )
          await updateLastIndexedBlockNumber(
            startBlock + blocksToProcess,
            lastIndexedBlock
          )
        }
      } else {
        await sleep(interval)
      }
      await processReindex(provider, signer, rpcDetails.chainId)
      lockProccessing = false
    } else {
      INDEXER_LOGGER.logMessage(
        `Processing already in progress for network ${rpcDetails.network}, waiting until finishing the current processing ...`
      )
    }

    // reindex chain command called
    if (REINDEX_BLOCK && !lockProccessing) {
      const networkHeight = await getNetworkHeight(provider)
      // either "true" for success or "false" otherwise
      const result = await reindexChain(currentBlock, networkHeight)
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

async function reindexChain(
  currentBlock: number,
  networkHeight: number
): Promise<boolean> {
  if (REINDEX_BLOCK > networkHeight) {
    INDEXER_LOGGER.error(
      `Invalid reindex block! ${REINDEX_BLOCK} is bigger than network height: ${networkHeight}. Continue indexing normally...`
    )
    REINDEX_BLOCK = null
    return false
  }
  // for reindex command we don't care about last known/saved block
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

parentPort.on('message', (message) => {
  if (message.method === INDEXER_MESSAGES.START_CRAWLING) {
    // start indexing the chain
    const blockchain = new Blockchain(
      rpcDetails.rpc,
      rpcDetails.network,
      rpcDetails.chainId,
      rpcDetails.fallbackRPCs
    )
    // return retryCrawlerWithDelay(blockchain)
    processNetworkData(blockchain.getProvider(), blockchain.getSigner())
  } else if (message.method === INDEXER_MESSAGES.REINDEX_TX) {
    // reindex a specific transaction

    REINDEX_QUEUE.push(message.data.reindexTask)
  } else if (message.method === INDEXER_MESSAGES.REINDEX_CHAIN) {
    // reindex a specific chain

    // get the deploy block number
    const deployBlock = getDeployedContractBlock(rpcDetails.chainId)
    // first option
    let possibleBlock =
      rpcDetails.startBlock && rpcDetails.startBlock >= deployBlock
        ? rpcDetails.startBlock
        : deployBlock

    // do we have a specific block number?
    const { block } = message.data
    if (block && !isNaN(block)) {
      // we still need to check network height
      if (block > deployBlock) {
        possibleBlock = block
      }
    }
    REINDEX_BLOCK = possibleBlock
  } else if (message.method === INDEXER_MESSAGES.STOP_CRAWLING) {
    // stop indexing the chain
    stoppedCrawling = true
    INDEXER_LOGGER.warn('Stopping crawler thread once current run finishes...')
  }
})
