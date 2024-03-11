import { parentPort, workerData } from 'worker_threads'
import {
  getCrawlingInterval,
  getDeployedContractBlock,
  getNetworkHeight,
  processBlocks,
  processChunkLogs
} from './utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { BlocksEvents, SupportedNetwork } from '../../@types/blockchain.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { sleep } from '../../utils/util.js'
import { EVENTS } from '../../utils/index.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { getDatabase } from '../../utils/database.js'

export interface ReindexTask {
  txId: string
  chainId: string
  eventIndex?: number
}

const REINDEX_QUEUE: ReindexTask[] = []

interface ThreadData {
  rpcDetails: SupportedNetwork
  lastIndexedBlock: number
}

let { rpcDetails, lastIndexedBlock } = workerData as ThreadData

const blockchain = new Blockchain(rpcDetails.rpc, rpcDetails.chainId)
const provider = blockchain.getProvider()
const signer = blockchain.getSigner()

async function updateLastIndexedBlockNumber(block: number): Promise<void> {
  try {
    const { indexer } = await getDatabase()
    const updatedIndex = await indexer.update(rpcDetails.chainId, block)
    INDEXER_LOGGER.logMessage(
      `New last indexed block : ${updatedIndex.lastIndexedBlock}`,
      true
    )
  } catch (err) {
    INDEXER_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_ERROR,
      `Error updating last indexed block ${err.message}`,
      true
    )
  }
}
export async function proccesNetworkData(): Promise<void> {
  const deployedBlock = getDeployedContractBlock(rpcDetails.chainId)
  if (deployedBlock == null && lastIndexedBlock == null) {
    INDEXER_LOGGER.logMessage(
      `chain: ${rpcDetails.chainId} Both deployed block and last indexed block are null. Cannot proceed further on this chain`,
      true
    )
    return
  }

  // we can override the default value of 30 secs, by setting process.env.INDEXER_INTERVAL
  const interval = getCrawlingInterval()

  while (true) {
    const networkHeight = await getNetworkHeight(provider)

    const startBlock =
      lastIndexedBlock && lastIndexedBlock > deployedBlock
        ? lastIndexedBlock
        : deployedBlock

    INDEXER_LOGGER.logMessage(
      `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`,
      true
    )

    if (networkHeight > startBlock) {
      let { chunkSize } = rpcDetails
      const remainingBlocks = networkHeight - startBlock
      const blocksToProcess = Math.min(chunkSize, remainingBlocks)
      INDEXER_LOGGER.logMessage(
        `network: ${rpcDetails.network} processing ${blocksToProcess} blocks ...`
      )

      try {
        const processedBlocks = await processBlocks(
          signer,
          provider,
          rpcDetails.chainId,
          startBlock,
          blocksToProcess
        )
        updateLastIndexedBlockNumber(processedBlocks.lastBlock)
        checkNewlyIndexedAssets(processedBlocks.foundEvents)
        lastIndexedBlock = processedBlocks.lastBlock
      } catch (error) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `network: ${rpcDetails.network} Error: ${error.message} `,
          true
        )
        chunkSize = Math.floor(chunkSize / 2)
        INDEXER_LOGGER.logMessage(
          `network: ${rpcDetails.network} Reducing chunk size  ${chunkSize} `,
          true
        )
      }
    }
    processReindex()
    await sleep(interval)
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
})
