import { parentPort, workerData } from 'worker_threads'
import { getDeployedContractBlock, getNetworkHeight, processBlocks } from './utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { SupportedNetwork } from '../../@types/blockchain.js'
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
  LOGGER_MODULE_NAMES.DATABASE,
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
      `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`
    )

    if (networkHeight > startBlock) {
      let { chunkSize } = rpcDetails
      let remainingBlocks = networkHeight - startBlock
      INDEXER_LOGGER.logMessage(
        `network: ${rpcDetails.network} Remaining blocks ${remainingBlocks} `
      )

      while (remainingBlocks > 0) {
        const blocksToProcess = Math.min(chunkSize, remainingBlocks)

        const processedBlocks = await processBlocks(provider, startBlock, blocksToProcess)

        startBlock += processedBlocks

        parentPort.postMessage({
          method: 'store-last-indexed-block',
          network: rpcDetails.chainId,
          data: startBlock
        })

        if (processedBlocks !== blocksToProcess) {
          chunkSize = Math.floor(chunkSize / 2)
          INDEXER_LOGGER.logMessage(
            `network: ${rpcDetails.network} Reducing chink size  ${chunkSize} `
          )
        }

        remainingBlocks -= processedBlocks
      }
    }

    parentPort.postMessage({ event: 'metadata-created' })
    await delay(30000)
  }
}

parentPort.on('message', (message) => {
  INDEXER_LOGGER.logMessage('message --', message)
  if (message.method === 'start-crawling') {
    proccesNetworkData()
  }
})
