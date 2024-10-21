import EventEmitter from 'node:events'
import { Worker } from 'node:worker_threads'
import { Database } from '../database/index.js'
import { RPCS, SupportedNetwork } from '../../@types/blockchain.js'
import { ReindexTask } from './crawlerThread.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'
import {
  Blockchain,
  EVENTS,
  INDEXER_CRAWLING_EVENTS,
  INDEXER_MESSAGES,
  PROTOCOL_COMMANDS
} from '../../utils/index.js'
import { CommandStatus, JobStatus } from '../../@types/commands.js'
import { buildJobIdentifier } from './utils.js'
import { create256Hash } from '../../utils/crypt.js'
import { isReachableConnection } from '../../utils/database.js'
import { sleep } from '../../utils/util.js'

// emmit events for node
export const INDEXER_DDO_EVENT_EMITTER = new EventEmitter()
export const INDEXER_CRAWLING_EVENT_EMITTER = new EventEmitter()

let INDEXING_QUEUE: ReindexTask[] = []
// job queue for admin commands or other commands not immediately available
const JOBS_QUEUE: JobStatus[] = []

const MAX_CRAWL_RETRIES = 10
let numCrawlAttempts = 0
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

  // stops all worker threads
  public stopAllThreads(): boolean {
    let count = 0
    for (const chainID of this.supportedChains) {
      if (this.stopThread(parseInt(chainID))) {
        count++
      }
    }
    return count === this.supportedChains.length
  }

  // stops crawling for a specific chain
  public stopThread(chainID: number): boolean {
    const worker = this.workers[chainID]
    if (worker) {
      worker.postMessage({ method: 'stop-crawling' })
      return true
    }
    INDEXER_LOGGER.error('Unable to find running worker thread for chain ' + chainID)
    return false
  }

  // it does not start crawling until the network connectin is ready
  async startCrawler(blockchain: Blockchain): Promise<boolean> {
    if ((await blockchain.isNetworkReady()).ready) {
      return true
    } else {
      // try other RPCS if any available (otherwise will just retry the same RPC)
      const connectionStatus = await blockchain.tryFallbackRPCs()
      if (connectionStatus.ready || (await blockchain.isNetworkReady()).ready) {
        return true
      }
    }
    return false
  }

  async retryCrawlerWithDelay(
    blockchain: Blockchain,
    interval: number = 5000 // in milliseconds, default 5 secs
  ): Promise<boolean> {
    try {
      const retryInterval = Math.max(blockchain.getKnownRPCs().length * 3000, interval) // give 2 secs per each one
      // try
      const result = await this.startCrawler(blockchain)
      const dbActive = this.getDatabase()
      if (!dbActive || !(await isReachableConnection(dbActive.getConfig().url))) {
        INDEXER_LOGGER.error(`Giving up start crawling. DB is not online!`)
        return false
      }
      if (result) {
        INDEXER_LOGGER.info('Blockchain connection succeffully established!')
        // processNetworkData(blockchain.getProvider(), blockchain.getSigner())
        return true
      } else {
        INDEXER_LOGGER.warn(
          `Blockchain connection is not established, retrying again in ${
            retryInterval / 1000
          } secs....`
        )
        numCrawlAttempts++
        if (numCrawlAttempts <= MAX_CRAWL_RETRIES) {
          // delay the next call
          await sleep(retryInterval)
          // recursively call the same func
          return this.retryCrawlerWithDelay(blockchain, retryInterval)
        } else {
          INDEXER_LOGGER.error(
            `Giving up start crawling after ${MAX_CRAWL_RETRIES} retries.`
          )
          return false
        }
      }
    } catch (err) {
      INDEXER_LOGGER.error(`Error starting crawler: ${err.message}`)
      return false
    }
  }

  // starts crawling for a specific chain
  public async startThread(chainID: number): Promise<Worker | null> {
    const rpcDetails: SupportedNetwork = this.getSupportedNetwork(chainID)
    if (!rpcDetails) {
      INDEXER_LOGGER.error(
        'Unable to start (unsupported network) a worker thread for chain: ' + chainID
      )
      return null
    }

    // check the network before starting crawling
    // having this code inside the thread itself is problematic because
    // the worker thread can exit and we keep processing code inside, leading to segfaults
    const blockchain = new Blockchain(
      rpcDetails.rpc,
      rpcDetails.network,
      rpcDetails.chainId,
      rpcDetails.fallbackRPCs
    )
    const canStartWorker = await this.retryCrawlerWithDelay(blockchain)
    if (!canStartWorker) {
      INDEXER_LOGGER.error(`Cannot start worker thread. Check DB and RPC connections!`)
      return null
    }
    const workerData = { rpcDetails }
    // see if it exists already, otherwise create a new one
    let worker = this.workers[chainID]
    if (!worker) {
      worker = new Worker('./dist/components/Indexer/crawlerThread.js', {
        workerData
      })
    }

    worker.postMessage({ method: 'start-crawling' })
    INDEXER_LOGGER.log(
      LOG_LEVELS_STR.LEVEL_INFO,
      `Starting worker for network ${rpcDetails.network} with ${JSON.stringify(
        workerData
      )}`,
      true
    )
    return worker
  }

  // eslint-disable-next-line require-await
  public async startThreads(): Promise<boolean> {
    let count = 0
    for (const network of this.supportedChains) {
      const chainId = parseInt(network)
      const worker = await this.startThread(chainId)
      if (worker) {
        // track if we were able to start them all
        count++
        this.workers[chainId] = worker
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
                create256Hash([event.data.chainId, event.data.txId].join('')),
                CommandStatus.SUCCESS
              )
            } else if (event.method === INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN) {
              // we should listen to this on the dashboard for instance
              INDEXER_CRAWLING_EVENT_EMITTER.emit(
                INDEXER_CRAWLING_EVENTS.REINDEX_CHAIN,
                event.data
              )
              this.updateJobStatus(
                PROTOCOL_COMMANDS.REINDEX_CHAIN,
                create256Hash([event.data.chainId].join('')),
                event.data.result ? CommandStatus.SUCCESS : CommandStatus.FAILURE
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
      }
    }
    return count === this.supportedChains.length
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
      const pos = -1
      const result = this.filterJobs(jobId)
      // if it finished, then we can remove it from the list of jobs
      if (
        result.jobsResult.length === 1 &&
        [CommandStatus.FAILURE, CommandStatus.SUCCESS].includes(
          result.jobsResult[0].status
        )
      ) {
        JOBS_QUEUE.splice(pos, 1)
      }
      return result.jobsResult
    }
    return JOBS_QUEUE.slice()
  }

  // when we add a new job, we change the status from DELIVERED to PENDING if still running after a couple secs
  public addJob(jobInfo: JobStatus) {
    JOBS_QUEUE.push(jobInfo)
    setTimeout(() => {
      const result = this.filterJobs(jobInfo.jobId)
      if (
        result.jobsResult.length === 1 &&
        result.jobsResult[0].status === CommandStatus.DELIVERED
      ) {
        this.updateJobStatus(jobInfo.command, jobInfo.hash, CommandStatus.PENDING)
      }
    }, 2000)
  }

  // filter jobs by job id, return the position of the job on the queue as well
  private filterJobs(jobId: string): { position: number; jobsResult: JobStatus[] } {
    let pos = -1
    const result = JOBS_QUEUE.filter((job: JobStatus, index: number) => {
      if (job.jobId === jobId) {
        pos = index
        return true
      }
      return false
    })
    return { position: pos, jobsResult: result }
  }

  // update the job status, given the command and the hash
  private updateJobStatus(command: string, hash: string, newStatus: CommandStatus) {
    if (JOBS_QUEUE.length > 0) {
      for (let i = JOBS_QUEUE.length - 1; i >= 0; i--) {
        const job = JOBS_QUEUE[i]
        // make sure we always pick the correct one
        if (job.command === command && hash === job.hash) {
          job.status = newStatus
        }
      }
    }
  }
}
