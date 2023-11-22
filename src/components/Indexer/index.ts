import { Worker } from 'node:worker_threads'
import { Database } from '../database'
import { RPCS, SupportedNetwork } from '../../@types/blockchain'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export class OceanIndexer {
  private db: Database
  private networks: RPCS
  private supportedChains: string[]

  constructor(db: Database, supportedNetworks: RPCS) {
    this.db = db
    this.networks = supportedNetworks
    this.supportedChains = Object.keys(supportedNetworks)
    this.startThreads()
  }

  public async startThreads(): Promise<void> {
    for (const network of this.supportedChains) {
      const chainId = parseInt(network)
      const rpcDetails: SupportedNetwork = this.networks[network]
      const lastIndexedBlock = await this.getLastIndexedBlock(chainId)
      const worker = new Worker('./dist/components/Indexer/crawlerThread.js', {
        workerData: { rpcDetails, lastIndexedBlock }
      })

      worker.on('message', (event: any) => {
        if (event.method === 'store-last-indexed-block') {
          this.updateLastIndexedBlockNumber(event.network, event.data)
        }
        INDEXER_LOGGER.logMessage(
          `Main thread message from worker for network ${network}: ${event}`,
          true
        )
        // index the DDO in the typesense db
      })

      worker.on('error', (err: Error) => {
        INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEl_ERROR,
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
    }
  }

  public async getLastIndexedBlock(network: number): Promise<number> {
    const dbconn = this.db.indexer
    try {
      const indexer = await dbconn.retrieve(network)
      return indexer?.lastIndexedBlock
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEl_ERROR,
        'Error retrieving last indexed block',
        true
      )
      return null
    }
  }

  public async updateLastIndexedBlockNumber(
    network: number,
    block: number
  ): Promise<void> {
    const dbconn = this.db.indexer
    try {
      const updatedIndex = await dbconn.update(network, block)
      INDEXER_LOGGER.logMessage(`New last indexed block :, ${updatedIndex}`, true)
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEl_ERROR,
        'Error retrieving last indexed block',
        true
      )
    }
  }
}
