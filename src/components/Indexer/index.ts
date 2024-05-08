import EventEmitter from 'node:events'
import { Worker } from 'node:worker_threads'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { ReindexTask } from './crawlerThread.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { EVENTS, INDEXER_CRAWLING_EVENTS } from '../../utils/index.js'

// emmit events for node
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()
export const INDEXER_CRAWLING_EVENT_EMITTER = new EventEmitter()

let INDEXING_QUEUE: ReindexTask[] = []
export let NUM_INDEXERS = 0
export let NUM_WORKERS = 0

export class OceanIndexer {
  private db: Database
  private networks: RPCS
  private supportedChains: string[]
  private workers: Record<string, Worker> = {}

  constructor(db: Database, supportedNetworks: RPCS) {
    this.db = db
    this.networks = supportedNetworks
    this.supportedChains = Object.keys(supportedNetworks)
    INDEXING_QUEUE = []
    NUM_INDEXERS++
    this.startThreads()
  }

  public getSupportedNetworks(): RPCS {
    return this.networks
  }

  public getDatabase(): Database {
    return this.db
  }

  public getSupportedNetwork(chainId: number): SupportedNetwork {
    let network: SupportedNetwork
    // the following will us to quickly define rpc
    //  export RPCS="{ \"8996\": \"http://127.0.0.1:8545\"}
    if (typeof this.networks[chainId] === 'string') {
      network = {
        chainId,
        network: String(chainId),
        rpc: String(this.networks[chainId])
      }
    } else {
      network = this.networks[chainId]
    }
    // set some defaults if needed
    if (!network.chunkSize) network.chunkSize = 1
    return network
  }

  // TODO check
  // private async stopThread(chainID: string): Promise<number> {
  //   const worker = OceanIndexer.workers[chainID]
  //   if (worker) {
  //     // return await worker.terminate()
  //   }
  //   return -1
  // }

  public stopAllThreads(): boolean {
    for (const chainID of this.supportedChains) {
      const worker = this.workers[chainID]
      if (worker) {
        worker.postMessage({ method: 'stop-crawling' })
        NUM_WORKERS--
      }
    }
    return true
  }

  // eslint-disable-next-line require-await
  public async startThreads(): Promise<void> {
    console.log('NUM_INDEXERS: ', NUM_INDEXERS)
    for (const network of this.supportedChains) {
      const chainId = parseInt(network)
      const rpcDetails: SupportedNetwork = this.getSupportedNetwork(chainId)
      const workerData = { rpcDetails }
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_INFO,
        `Starting worker for network ${network} with ${JSON.stringify(workerData)}`,
        true
      )

      const worker = new Worker('./dist/components/Indexer/crawlerThread.js', {
        workerData
      })
      NUM_WORKERS++
      console.log('NUM_WORKERS: ', NUM_WORKERS)

      worker.on('message', (event: any) => {
        if (event.data) {
          if (
            [
              EVENTS.METADATA_CREATED,
              EVENTS.METADATA_UPDATED,
              EVENTS.METADATA_STATE,
              EVENTS.ORDER_STARTED,
              EVENTS.ORDER_REUSED
            ].includes(event.method)
          ) {
            // will emit the metadata created/updated event and advertise it to the other peers (on create only)
            INDEXER_LOGGER.logMessage(
              `Emiting "${event.method}" for DDO : ${event.data.id} from network: ${network} `
            )
            INDEXER_DDO_EVENT_EMITTER.emit(event.method, event.data.id)
            // remove from indexing list
          } else if (event.method === INDEXER_CRAWLING_EVENTS.REINDEX_QUEUE_POP) {
            // remove this one from the queue
            INDEXING_QUEUE = INDEXING_QUEUE.filter(
              (task) =>
                task.txId !== event.data.txId && task.chainId !== event.data.chainId
            )
          } else if (event.method === INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED) {
            INDEXER_CRAWLING_EVENT_EMITTER.emit(event.method, event.data)
          }
        } else {
          INDEXER_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            'Missing event data (ddo) on postMessage. Something is wrong!',
            true
          )
        }
      })

      worker.on('error', (err: Error) => {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error in worker for network ${network}: ${err.message}`,
          true
        )
      })

      worker.on('exit', (code: number) => {
        NUM_WORKERS--
        console.log('NUM_WORKERS:', NUM_WORKERS)
        INDEXER_LOGGER.logMessage(
          `Worker for network ${network} exited with code: ${code}`,
          true
        )
      })

      worker.postMessage({ method: 'start-crawling' })
      this.workers[network] = worker
    }
  }

  public addReindexTask(reindexTask: ReindexTask): void {
    const worker = this.workers[reindexTask.chainId]
    if (worker) {
      worker.postMessage({ method: 'add-reindex-task', reindexTask })
      INDEXING_QUEUE.push(reindexTask)
    }
  }

  public resetCrawling(chainId: number): void {
    const worker = this.workers[chainId]
    if (worker) {
      worker.postMessage({ method: 'reset-crawling' })
    }
  }

  public getIndexingQueue(): ReindexTask[] {
    return INDEXING_QUEUE.slice()
  }
}
