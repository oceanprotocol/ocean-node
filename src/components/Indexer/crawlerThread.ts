import { parentPort, workerData } from 'worker_threads'
import {
  getDeployedContractBlock,
  getNetworkHeight,
  processBlocks,
  processChunkLogs
} from './utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { BlocksEvents, SupportedNetwork } from '../../@types/blockchain.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { sleep } from '../../utils/util.js'
import { INDEXER_LOGGER } from './index.js'

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

export async function proccesNetworkData(): Promise<void> {
  while (true) {
    const networkHeight = await getNetworkHeight(provider)

    const deployedBlock = await getDeployedContractBlock(rpcDetails.chainId)

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
          provider,
          rpcDetails.chainId,
          startBlock,
          blocksToProcess
        )
        parentPort.postMessage({
          method: 'store-last-indexed-block',
          network: rpcDetails.chainId,
          data: processedBlocks.lastBlock
        })
        lastIndexedBlock = processedBlocks.lastBlock
        await storeFoundEvents(processedBlocks.foundEvents)
      } catch (error) {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `network: ${rpcDetails.network} Error: ${error.message} `,
          true
        )
        chunkSize = Math.floor(chunkSize / 2)
        INDEXER_LOGGER.logMessage(
          `network: ${rpcDetails.network} Reducing chink size  ${chunkSize} `,
          true
        )
      }
    }
    processReindex()
    await sleep(30000)
  }
}

async function processReindex(): Promise<void> {
  while (REINDEX_QUEUE.length > 0) {
    const reindexTask = REINDEX_QUEUE.pop()
    try {
      const provider = blockchain.getProvider()
      const receipt = await provider.getTransactionReceipt(reindexTask.txId)
      if (receipt) {
        const log = receipt.logs[reindexTask.eventIndex]
        const logs = log ? [log] : receipt.logs
        const events = await processChunkLogs(logs, provider, rpcDetails.chainId)
        const eventKeys = Object.keys(events)
        eventKeys.forEach((eventType) => {
          INDEXER_LOGGER.logMessage(
            `REINDEX Network: ${rpcDetails.network} storing event type  ${eventType} `,
            true
          )
          parentPort.postMessage({
            method: eventType,
            network: rpcDetails.chainId,
            data: events[eventType]
          })
        })
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

export async function storeFoundEvents(events: BlocksEvents): Promise<void> {
  const eventKeys = Object.keys(events)
  eventKeys.forEach((eventType) => {
    INDEXER_LOGGER.logMessage(
      `Network: ${rpcDetails.network} storing event type  ${eventType} `,
      true
    )
    parentPort.postMessage({
      method: eventType,
      network: rpcDetails.chainId,
      data: events[eventType]
    })
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
