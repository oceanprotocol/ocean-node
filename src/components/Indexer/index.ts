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
import EventEmitter from 'node:events'
import { ReindexItem } from "./reindexThread.js";

export const INDEXER_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.INDEXER,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
// emmit events for node
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()

export class OceanIndexer {
  private db: Database
  private networks: RPCS
  private supportedChains: string[]
  private reindex: Worker

  constructor(db: Database, supportedNetworks: RPCS) {
    this.db = db
    this.networks = supportedNetworks
    this.supportedChains = Object.keys(supportedNetworks)
    this.startThreads()
    this.reindexThread()
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
        if (
          event.method === EVENTS.METADATA_CREATED ||
          event.method === EVENTS.METADATA_UPDATED ||
          event.method === EVENTS.METADATA_STATE ||
          event.method === EVENTS.ORDER_STARTED ||
          event.method === EVENTS.ORDER_REUSED
        ) {
          this.createOrUpdateDDO(event.network, event.data, event.method)
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
    }
  }

  public async reindexThread(): Promise<void> {
    this.reindex = new Worker('./dist/components/Indexer/reindexThread.js')
    this.reindex.on('error', (err: Error) => {
      INDEXER_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Error in reindex worker: ${err.message}`,
          true
      )
    })

    this.reindex.on('exit', (code: number) => {
      INDEXER_LOGGER.logMessage(
          `Reindex worker exited with code: ${code}`,
          true
      )
    })
    this.reindex.postMessage({ method: 'process-reindex' })
  }

  public async addReindexQueueItem(reindexItem: ReindexItem): Promise<void> {
    this.reindex.postMessage({ method: 'add-queue-reindex', reindexItem })
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

  public async createOrUpdateDDO(
    network: number,
    ddo: any,
    method: string
  ): Promise<void> {
    const dbconn = this.db.ddo
    try {
      const saveDDO = await dbconn.update({ ...ddo })
      INDEXER_LOGGER.logMessage(
        `Saved or updated DDO  : ${saveDDO.id} from network: ${network} `
      )
      // emit event
      if (method === EVENTS.METADATA_CREATED) {
        INDEXER_DDO_EVENT_EMITTER.emit(EVENTS.METADATA_CREATED, saveDDO.id)
      }
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error retrieving & storing DDO: ${err}`,
        true
      )
    }
  }

  public async updateLastIndexedBlockNumber(
    network: number,
    block: number
  ): Promise<void> {
    const dbconn = this.db.indexer
    try {
      const updatedIndex = await dbconn.update(network, block)
      INDEXER_LOGGER.logMessage(
        `New last indexed block : ${updatedIndex.lastIndexedBlock}`,
        true
      )
    } catch (err) {
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        'Error retrieving last indexed block',
        true
      )
    }
  }
}
