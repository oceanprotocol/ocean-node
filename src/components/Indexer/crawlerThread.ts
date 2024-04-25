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
import { sleep } from '../../utils/util.js'
import { EVENTS } from '../../utils/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { getDatabase } from '../../utils/database.js'
import { Log } from 'ethers'

export interface ReindexTask {
  txId: string
  chainId: string
  eventIndex?: number
}

let REINDEX_BLOCK: number = null
const REINDEX_QUEUE: ReindexTask[] = []

interface ThreadData {
  rpcDetails: SupportedNetwork
}

const { rpcDetails } = workerData as ThreadData

const blockchain = new Blockchain(rpcDetails.rpc, rpcDetails.chainId)
const provider = blockchain.getProvider()
const signer = blockchain.getSigner()

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

async function deleteAllAssetsFromChain(): Promise<void> {
  const { ddo } = await getDatabase()
  try {
    await ddo.deleteAllAssetsFromChain(rpcDetails.chainId)
  } catch (err) {
    INDEXER_LOGGER.error(`Error deleting all assets: ${err}`)
    return null
  }
}

export async function proccesNetworkData(): Promise<void> {
  const deployedBlock = getDeployedContractBlock(rpcDetails.chainId)
  if (deployedBlock == null && (await getLastIndexedBlock()) == null) {
    INDEXER_LOGGER.logMessage(
      `chain: ${rpcDetails.chainId} Both deployed block and last indexed block are null. Cannot proceed further on this chain`,
      true
    )
    return null
  }

  // we can override the default value of 30 secs, by setting process.env.INDEXER_INTERVAL
  const interval = getCrawlingInterval()
  let { chunkSize } = rpcDetails
  let lockProccessing = false
  while (true) {
    let currentBlock
    if (!lockProccessing) {
      lockProccessing = true
      const indexedBlock = await getLastIndexedBlock()
      const networkHeight = await getNetworkHeight(provider)

      const startBlock =
        indexedBlock && indexedBlock > deployedBlock ? indexedBlock : deployedBlock

      INDEXER_LOGGER.logMessage(
        `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`,
        true
      )
      if (networkHeight > startBlock) {
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
          await updateLastIndexedBlockNumber(processedBlocks.lastBlock)
          currentBlock = processedBlocks.lastBlock
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
      await processReindex()
      lockProccessing = false
    } else {
      INDEXER_LOGGER.logMessage(
        `Processing already in progress for network ${rpcDetails.network} waiting untill finishing the current processing ...`,
        true
      )
    }
    await sleep(interval)
    // reindex chain command called
    if (REINDEX_BLOCK && !lockProccessing) {
      await reindexChain(currentBlock)
    }
  }
}

async function reindexChain(currentBlock: number): Promise<void> {
  const block = await updateLastIndexedBlockNumber(REINDEX_BLOCK)
  if (block !== null) {
    INDEXER_LOGGER.logMessage(`Block updated for reindexing chain ${REINDEX_BLOCK}`)
    REINDEX_BLOCK = null
    const res = await deleteAllAssetsFromChain()
    if (res !== null) {
      INDEXER_LOGGER.logMessage(`Assets deleted from db for chain ${rpcDetails.chainId}`)
    } else {
      INDEXER_LOGGER.error(
        `Assets could not be deleted for chain ${rpcDetails.chainId}. Reverting block...`
      )
      await updateLastIndexedBlockNumber(currentBlock)
    }
  } else {
    INDEXER_LOGGER.error(`Block could not be reset. Continue indexing normally...`)
    REINDEX_BLOCK = null
  }
}

async function processReindex(): Promise<void> {
  while (REINDEX_QUEUE.length > 0) {
    const reindexTask = REINDEX_QUEUE.pop()
    try {
      const receipt = await provider.getTransactionReceipt(reindexTask.txId)
      if (receipt) {
        const log = receipt.logs[reindexTask.eventIndex]
        const logs = log ? [log] : receipt.logs
        await processChunkLogs(logs, signer, provider, rpcDetails.chainId)
        // clear from the 'top' queue
        parentPort.postMessage({
          method: 'popFromQueue',
          data: reindexTask
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
  if (message.method === 'start-crawling') {
    proccesNetworkData()
  }
  if (message.method === 'add-reindex-task') {
    if (message.reindexTask) {
      REINDEX_QUEUE.push(message.reindexTask)
    }
  }
  if (message.method === 'reset-crawling') {
    REINDEX_BLOCK = getDeployedContractBlock(rpcDetails.chainId)
  }
})
