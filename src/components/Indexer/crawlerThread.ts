import { parentPort, workerData } from 'worker_threads'
import { getDeployedContractBlock, getNetworkHeight, processBlocks } from './utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { BlocksEvents, SupportedNetwork } from '../../@types/blockchain.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'

interface ThreadData {
  rpcDetails: SupportedNetwork
  lastIndexedBlock: number
}

const { rpcDetails, lastIndexedBlock } = workerData as ThreadData

const blockchain = new Blockchain(rpcDetails.rpc, rpcDetails.chainId)
const provider = blockchain.getProvider()

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function proccesNetworkData(): Promise<void> {
  let lastSavedBlock = lastIndexedBlock
  while (true) {
    const networkHeight = await getNetworkHeight(provider)

    const deployedBlock = await getDeployedContractBlock(rpcDetails.chainId)

    const startBlock =
      lastSavedBlock && lastSavedBlock > deployedBlock ? lastSavedBlock : deployedBlock

    INDEXER_LOGGER.logMessage(
      `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`,
      true
    )

    if (networkHeight > startBlock) {
      let { chunkSize } = rpcDetails
      const remainingBlocks = networkHeight - startBlock
      INDEXER_LOGGER.logMessage(
        `network: ${rpcDetails.network} Remaining blocks ${remainingBlocks} `
      )
      const blocksToProcess = Math.min(chunkSize, remainingBlocks)
      INDEXER_LOGGER.logMessage(
        `network: ${rpcDetails.network} processing ${blocksToProcess} blocks ...`
      )

      try {
        const fromBlock = startBlock + 1
        const processedBlocks = await processBlocks(
          provider,
          rpcDetails.chainId,
          fromBlock,
          blocksToProcess
        )
        parentPort.postMessage({
          method: 'store-last-indexed-block',
          network: rpcDetails.chainId,
          data: processedBlocks.lastBlock
        })
        lastSavedBlock = processedBlocks.lastBlock
        await storeFoundEvents(processedBlocks.foundEvents)
      } catch (error) {
        chunkSize = Math.floor(chunkSize / 2)
        INDEXER_LOGGER.logMessage(
          `network: ${rpcDetails.network} Reducing chink size  ${chunkSize} `,
          true
        )
      }
    }
    await delay(30000)
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
})
