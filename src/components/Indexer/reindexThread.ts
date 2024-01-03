import { parentPort, workerData } from 'worker_threads'
import { sleep } from '../../utils/util.js'
import { RPCS } from '../../@types/blockchain.js'
import { Blockchain } from '../../utils/blockchain.js'
import { REINDEXER_LOGGER } from './index.js'
import { Log } from 'ethers'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'

export interface ReindexItem {
  txId: string
  chainId: string
  eventIndex?: number
}

const { supportedNetworks } = workerData as { supportedNetworks: RPCS }

const REINDEX_QUEUE: Log[] = []

async function processReindex(): Promise<void> {
  while (true) {
    console.log('REINDEX_QUEUE', REINDEX_QUEUE)
    const log = REINDEX_QUEUE.pop()
    if (log) {
      // ...
    }
    await sleep(10000)
  }
}

async function addReindexQueue(reindexItem: ReindexItem): Promise<void> {
  try {
    const network = supportedNetworks[reindexItem.chainId]
    if (network) {
      REINDEXER_LOGGER.logMessage(
        `network: ${network.network} processing reindex ${reindexItem.txId} tx ...`,
        true
      )
      const blockchain = new Blockchain(network.rpc, network.chainId)
      const provider = blockchain.getProvider()
      const txReceipt = await provider.getTransactionReceipt(reindexItem.txId)
      console.log('txReceipt', txReceipt)
      if (txReceipt) {
        const log = txReceipt.logs[reindexItem.eventIndex]
        if (log) {
          REINDEX_QUEUE.push(log)
        } else {
          REINDEX_QUEUE.push(...txReceipt.logs)
        }
      }
    }
  } catch (error) {
    REINDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error.message} `, true)
  }
}

parentPort.on('message', (message) => {
  if (message.method === 'process-reindex') {
    processReindex()
  }
  if (message.method === 'add-reindex-item') {
    if (message.reindexItem) {
      addReindexQueue(message.reindexItem)
    }
  }
})
