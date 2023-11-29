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
  while (true) {
    const networkHeight = await getNetworkHeight(provider)

    const deployedBlock = await getDeployedContractBlock(rpcDetails.chainId)

    let startBlock =
      lastIndexedBlock && lastIndexedBlock > deployedBlock
        ? lastIndexedBlock
        : deployedBlock

    INDEXER_LOGGER.logMessage(
      `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`,
      true
    )
    console.log(
      `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`
    )

    if (networkHeight > startBlock) {
      let { chunkSize } = rpcDetails
      let remainingBlocks = networkHeight - startBlock
      INDEXER_LOGGER.logMessage(
        `network: ${rpcDetails.network} Remaining blocks ${remainingBlocks} `
      )
      console.log(`network: ${rpcDetails.network} Remaining blocks ${remainingBlocks} `)

      while (remainingBlocks > 0) {
        const blocksToProcess = Math.min(chunkSize, remainingBlocks)

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
          await storeFoundEvents(processedBlocks.foundEvents)
          startBlock += blocksToProcess
          remainingBlocks -= blocksToProcess
        } catch (error) {
          chunkSize = Math.floor(chunkSize / 2)
          INDEXER_LOGGER.logMessage(
            `network: ${rpcDetails.network} Reducing chink size  ${chunkSize} `,
            true
          )
          console.log(`network: ${rpcDetails.network} Reducing chink size  ${chunkSize} `)
        }
      }
    }

    parentPort.postMessage({ event: 'metadata-created' })
    await delay(30000)
  }
}

export async function storeFoundEvents(events: BlocksEvents): Promise<void> {
  const eventKeys = Object.keys(events)
  eventKeys.forEach((eventType) => {
    INDEXER_LOGGER.logMessage(`store event ${events[eventType]}`)
    parentPort.postMessage({
      method: eventType,
      network: rpcDetails.chainId,
      data: events[eventType]
    })
  })
}
parentPort.on('message', (message) => {
  INDEXER_LOGGER.logMessage('message --', message)
  if (message.method === 'start-crawling') {
    proccesNetworkData()
  }
})
