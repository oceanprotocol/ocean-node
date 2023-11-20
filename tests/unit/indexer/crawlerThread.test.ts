import { expect } from 'chai'
import { describe, it, before, after } from 'mocha'
import { parentPort, workerData } from 'worker_threads'
import { proccesNetworkData } from '../../../src/components/Indexer/crawlerThread'
import { Blockchain } from '../../../src/utils/blockchain'
import { SupportedNetwork } from '../../../src/@types/blockchain'

describe('Your Test Suite Description', () => {
  let originalParentPort: any
  let originalWorkerData: any

  before(() => {
    originalParentPort = { ...parentPort }
    originalWorkerData = { ...workerData }
  })

  it('should process network data correctly', async () => {
    const mockProvider = {}

    const mockBlockchain = {
      getProvider: () => mockProvider
    } as Blockchain

    const mockRpcDetails: SupportedNetwork = {
      chainId: 1,
      network: 'mainnet',
      rpc: 'https://mainnet.rpc',
      chunkSize: 1000
    }

    Object.assign(workerData, { rpcDetails: mockRpcDetails, lastIndexedBlock: 0 })
    Object.assign(proccesNetworkData, {
      blockchain: mockBlockchain
    })

    // Perform the actual test
    await proccesNetworkData()
  })
})
