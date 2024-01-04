import { parentPort, workerData } from 'worker_threads'
import { sleep } from '../../utils/util.js'
import { RPCS } from '../../@types/blockchain.js'
import { Blockchain } from '../../utils/blockchain.js'
import {REINDEXER_LOGGER} from './index.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { processChunkLogs } from './utils.js'

export interface ReindexTask {
  txId: string
  chainId: string
  eventIndex?: number
}

const { supportedNetworks } = workerData as { supportedNetworks: RPCS }

const REINDEX_QUEUE: ReindexTask[] = []

async function processReindex(): Promise<void> {
  while (true) {
    while (REINDEX_QUEUE.length > 0) {
      const reindexTask = REINDEX_QUEUE.pop()
      console.log('log', reindexTask)
      try {
        const network = supportedNetworks[reindexTask.chainId]
        if (network) {
          REINDEXER_LOGGER.logMessage(
            `network: ${network.network} processing reindex ${reindexTask.txId} tx ...`,
            true
          )
          const blockchain = new Blockchain(network.rpc, network.chainId)
          const provider = blockchain.getProvider()
          const receipt = await provider.getTransactionReceipt(reindexTask.txId)
          if (receipt) {
            const log = receipt.logs[reindexTask.eventIndex]
            const logs = log ? [log] : receipt.logs
            const events = await processChunkLogs(logs, provider, network.chainId)
            console.log(events)
            const eventKeys = Object.keys(events)
            eventKeys.forEach((eventType) => {
              REINDEXER_LOGGER.logMessage(
                  `Network: ${network.network} storing event type  ${eventType} `,
                  true
              )
              parentPort.postMessage({
                method: eventType,
                network: network.chainId,
                data: events[eventType]
              })
            })
          }
        }
      } catch (error) {
        REINDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error: ${error.message} `,
          true
        )
      }
    }
    await sleep(10000)
  }
}

parentPort.on('message', (message) => {
  if (message.method === 'process-reindex') {
    processReindex()
  }
  if (message.method === 'add-reindex-task') {
    if (message.reindexTask) {
      REINDEX_QUEUE.push(message.reindexTask)
    }
  }
})
