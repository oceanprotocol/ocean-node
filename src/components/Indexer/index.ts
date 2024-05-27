import EventEmitter from 'node:events'
import { Worker } from 'node:worker_threads'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { ReindexTask } from './crawlerThread.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import {
  EVENTS,
  INDEXER_CRAWLING_EVENTS,
  INDEXER_MESSAGES,
  PROTOCOL_COMMANDS
} from '../../utils/index.js'
import { CommandStatus, JobStatus } from '../../@types/commands.js'
import { buildJobIdentifier } from './utils.js'
import { create256Hash } from '../../utils/crypt.js'

// emmit events for node
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()
export const INDEXER_CRAWLING_EVENT_EMITTER = new EventEmitter()

let INDEXING_QUEUE: ReindexTask[] = []
// job queue for admin commands or other commands not immediately available
const JOBS_QUEUE: JobStatus[] = []

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

  // stops crawling for a specific chain
  public stopThread(chainID: string): boolean {
    const worker = this.workers[chainID]
    if (worker) {
      worker.postMessage({ method: 'stop-crawling' })
    }
    return true
  }

  // stops all worker threads
  public stopAllThreads(): boolean {
    for (const chainID of this.supportedChains) {
      this.stopThread(chainID)
    }
    return true
  }

  // eslint-disable-next-line require-await
  public async startThreads(): Promise<void> {
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
            // remove this one from the queue (means we processed the reindex for this tx)
            INDEXING_QUEUE = INDEXING_QUEUE.filter(
              (task) =>
                task.txId !== event.data.txId && task.chainId !== event.data.chainId
            )
            // reindex tx successfully done
            INDEXER_CRAWLING_EVENT_EMITTER.emit(
              INDEXER_CRAWLING_EVENTS.REINDEX_TX, // explicitly set constant value for readability
              event.data
            )
            this.updateJobStatus(
              PROTOCOL_COMMANDS.REINDEX_TX,
              [event.data.chainId, event.data.txId],
              event.data.result
            )
          } else if (event.method === INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN) {
            // we should listen to this on the dashboard for instance
            INDEXER_CRAWLING_EVENT_EMITTER.emit(
              INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN,
              event.data
            )
            this.updateJobStatus(
              PROTOCOL_COMMANDS.REINDEX_CHAIN,
              [event.data.chainId],
              event.data.result
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
        INDEXER_LOGGER.logMessage(
          `Worker for network ${network} exited with code: ${code}`,
          true
        )
      })

      worker.postMessage({ method: INDEXER_MESSAGES.START_CRAWLING })
      this.workers[network] = worker
    }
  }

  public addReindexTask(reindexTask: ReindexTask): JobStatus | null {
    const worker = this.workers[reindexTask.chainId]
    if (worker) {
      const job = buildJobIdentifier(PROTOCOL_COMMANDS.REINDEX_TX, [
        reindexTask.chainId.toString(),
        reindexTask.txId
      ])
      worker.postMessage({
        method: INDEXER_MESSAGES.REINDEX_TX,
        data: { reindexTask, msgId: job.jobId }
      })
      INDEXING_QUEUE.push(reindexTask)
      this.addJob(job)
      return job
    }
    return null
  }

  public resetCrawling(chainId: number): JobStatus | null {
    const worker = this.workers[chainId]
    if (worker) {
      const job = buildJobIdentifier(PROTOCOL_COMMANDS.REINDEX_CHAIN, [
        chainId.toString()
      ])
      worker.postMessage({
        method: INDEXER_MESSAGES.REINDEX_CHAIN,
        data: { msgId: job.jobId }
      })
      this.addJob(job)
      return job
    }
    return null
  }

  public getIndexingQueue(): ReindexTask[] {
    return INDEXING_QUEUE.slice()
  }

  public getJobsPool(jobId?: string): JobStatus[] {
    if (jobId) {
      let pos = -1
      const result = JOBS_QUEUE.filter((job: JobStatus, index: number) => {
        if (job.jobId === jobId) {
          pos = index
          return true
        }
        return false
      })

      // if it finished, then we can remove it from the list of jobs
      if (
        result.length === 1 &&
        [CommandStatus.FAILURE, CommandStatus.SUCCESS].includes(result[0].status)
      ) {
        JOBS_QUEUE.splice(pos, 1)
      }
      return result
    }
    return JOBS_QUEUE.slice()
  }

  public addJob(jobInfo: JobStatus) {
    JOBS_QUEUE.push(jobInfo)
  }

  private updateJobStatus(command: string, extra: string[], result: boolean) {
    if (JOBS_QUEUE.length) {
      for (let i = JOBS_QUEUE.length; i > 0; i--) {
        const job = JOBS_QUEUE[i]
        // make sure we always pick the correct one
        if (job.command === command && create256Hash(extra.join('')) === job.hash) {
          job.status = result ? CommandStatus.SUCCESS : CommandStatus.FAILURE
        }
      }
    }
  }
}
