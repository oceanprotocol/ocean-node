import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { Database } from '../database'
import { Blockchain } from '../../utils/blockchain'

export class OceanIndexer {
  private db: Database
  private networks: number[]
  private blockchain: Blockchain

  constructor(db: Database, supportedNetworks: number[], blockchain: Blockchain) {
    this.db = db
    this.blockchain = blockchain
    this.networks = supportedNetworks
    this.startThreads()
  }

  public startThreads(): void {
    for (const network of this.networks) {
      const provider = this.blockchain.getProvider(network)
      const lastIndexedBlock = this.getLastIndexedBlock(network)
      const worker = new Worker('./dist/components/Indexer/crawlerThread.js', {
        workerData: { network, lastIndexedBlock }
      })

      worker.on('message', (event: string) => {
        console.log(`new metadata-created from worker for network ${network}: ${event}`)
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
