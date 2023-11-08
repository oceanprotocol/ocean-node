import { ethers, Provider } from 'ethers'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { Database } from '../database'
import { Blockchain } from '../../utils/blockchain'

export class OceanIndexer {
  private db: Database
  private networks: number[]
  private blockchain: Blockchain

  constructor(
    db: Database,
    supportedNetworks: number[],
    blockchain: Blockchain,
  ) {
    this.db = db
    this.blockchain = blockchain
    this.networks = supportedNetworks
  }

  public startThreads(): void {
    for (const network of this.networks) {
      const worker = new Worker('./crawlerThread.ts', {
        workerData: { network }
      })

      worker.on('metadata-created', (message: string) => {
        console.log(`new metadata-created from worker for network ${network}: ${message}`)
      })

      worker.on('error', (err: Error) => {
        console.error(`Error in worker for network ${network}: ${err.message}`)
      })

      worker.on('exit', (code: number) => {
        console.log(`Worker for network ${network} exited with code: ${code}`)
      })
  }
}
