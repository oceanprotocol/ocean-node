import EventEmitter from 'node:events'
import { Worker, workerData } from 'node:worker_threads'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { ReindexTask } from './crawlerThread.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import { EVENTS } from '../../utils/index.js'

// emmit events for node
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()
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

  public async startThreads(): Promise<void> {
    for (const network of this.supportedChains) {
      const chainId = parseInt(network)
      const rpcDetails: SupportedNetwork = this.getSupportedNetwork(chainId)
      const lastIndexedBlock = await this.getLastIndexedBlock(chainId)
      const workerData = { rpcDetails, lastIndexedBlock }
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_INFO,
        `Starting worker for network ${network} with ${JSON.stringify(workerData)}`,
        true
      )

      const worker = new Worker('./dist/components/Indexer/crawlerThread.js', {
        workerData
      })

      worker.on('message', (event: any) => {
        if (event.method === EVENTS.METADATA_CREATED) {
          this.advertiseDDO(event.network, event.data, event.method)
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

  public async advertiseDDO(network: number, ddo: any, method: string): Promise<void> {
    INDEXER_LOGGER.logMessage(`Advertising new DDO : ${ddo.id} from network: ${network} `)
    INDEXER_DDO_EVENT_EMITTER.emit(method, ddo.id)
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
