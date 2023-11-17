import { Worker } from 'node:worker_threads'
import { Database } from '../database'
import { RPCS, SupportedNetwork } from '../../@types/blockchain'

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
        console.log(`Main thread message from worker for network ${network}: ${event}`)
        // index the DDO in the typesense db
      })

      worker.on('error', (err: Error) => {
        console.error(`Error in worker for network ${network}: ${err.message}`)
      })

      worker.on('exit', (code: number) => {
        console.log(`Worker for network ${network} exited with code: ${code}`)
      })

      worker.postMessage({ method: 'start-crawling' })
    }
  }

  private async getLastIndexedBlock(network: number): Promise<number> {
    const dbconn = this.db.indexer
    try {
      const indexer = await dbconn.retrieve(network)
      return indexer?.lastIndexedBlock
    } catch (err) {
      console.error('Error retrieving last indexed block')
      return null
    }
  }

  private async updateLastIndexedBlockNumber(
    network: number,
    block: number
  ): Promise<void> {
    const dbconn = this.db.indexer
    try {
      const updatedIndex = await dbconn.update(network, block)
      console.log('New last indexed block :', updatedIndex)
    } catch (err) {
      console.error('Error retrieving last indexed block')
    }
  }
}
