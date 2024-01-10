import { Worker } from 'node:worker_threads'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { EVENTS } from '../../utils/index.js'
import { ReindexTask } from './crawlerThread.js'

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export class OceanIndexer {
  private db: Database
  private networks: RPCS
  private supportedChains: string[]
  private static workers: Record<string, Worker> = {}

  constructor(db: Database, supportedNetworks: RPCS) {
    this.db = db
    this.networks = supportedNetworks
    this.supportedChains = Object.keys(supportedNetworks)
    this.startThreads()
  }

  public getSupportedNetworks(): RPCS {
    return this.networks
  }

  public getDatabase(): Database {
    return this.db
  }

  public async startThreads(): Promise<void> {
    for (const network of this.supportedChains) {
      const chainId = parseInt(network)
      const rpcDetails: SupportedNetwork = this.networks[network]
      const lastIndexedBlock = await this.getLastIndexedBlock(chainId)
      const worker = new Worker('./dist/components/Indexer/crawlerThread.js', {
        workerData: { rpcDetails, lastIndexedBlock }
      })

      // worker.on('message', (event: any) => {
      //   if (event.method === 'store-last-indexed-block') {
      //     this.updateLastIndexedBlockNumber(event.network, event.data)
      //   }
      //   if (
      //     event.method === EVENTS.METADATA_CREATED ||
      //     event.method === EVENTS.METADATA_UPDATED ||
      //     event.method === EVENTS.METADATA_STATE ||
      //     event.method === EVENTS.ORDER_STARTED ||
      //     event.method === EVENTS.ORDER_REUSED
      //   ) {
      //     this.createOrUpdateDDO(event.network, event.data, event.method)
      //   }
      // })

      worker.on('error', (err: Error) => {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error in worker for network ${network}: ${err.message}`,
          true
        )
      })

      worker.on('exit', (code: number) => {
        INDEXER_LOGGER.logMessage(
          `Worker for network ${network} exited with code: ${code}`,
          true
        )
      })

      worker.postMessage({ method: 'start-crawling' })
      OceanIndexer.workers[network] = worker
    }
  }

  static async addReindexTask(reindexTask: ReindexTask): Promise<void> {
    const worker = OceanIndexer.workers[reindexTask.chainId]
    if (worker) {
      worker.postMessage({ method: 'add-reindex-task', reindexTask })
    }
  }

  public async getLastIndexedBlock(network: number): Promise<number> {
    const dbconn = this.db.indexer
    try {
      const indexer = await dbconn.retrieve(network)
      return indexer?.lastIndexedBlock
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        'Error retrieving last indexed block',
        true
      )
      return null
    }
  }
}
