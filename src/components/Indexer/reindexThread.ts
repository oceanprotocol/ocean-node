import { parentPort } from 'worker_threads'
import { sleep } from '../../utils/util.js'

export interface ReindexItem {
  txId: string
  chainId: number
  eventIndex?: number
}

const REINDEX_QUEUE: ReindexItem[] = []

async function processReindex(): Promise<void> {
  while (true) {
    console.log('REINDEX_QUEUE', REINDEX_QUEUE)
    await sleep(1000)
  }
}

parentPort.on('message', (message) => {
  if (message.method === 'process-reindex') {
    processReindex()
  }
  if (message.method === 'add-queue-reindex') {
    if (message.reindexItem) {
      REINDEX_QUEUE.push(message.reindexItem)
    }
  }
})
