import { parentPort } from 'worker_threads'
import {
  detectDeployedBlock,
  getLastIndexedBlock,
  getNetworkHeight,
  processBlocks
} from './utils'
import { Provider } from 'ethers'
import { Providers } from '@libp2p/kad-dht/dist/src/providers'
interface WorkerData {
  provider: Provider
}

const workerData: WorkerData = parentPort.onmessage(async (message: WorkerData) => {
  const { provider } = message

  const deployedBlock = await detectDeployedBlock(provider)
  console.log('deployedBlock', deployedBlock)

  let lastIndexedBlock = await getLastIndexedBlock(provider)

  const networkHeight = await getNetworkHeight(provider)

  if (networkHeight > lastIndexedBlock) {
    let chunkSize = 100
    let remainingBlocks = networkHeight - lastIndexedBlock

    while (remainingBlocks > 0) {
      const blocksToProcess = Math.min(chunkSize, remainingBlocks)

      const processedBlocks = await processBlocks(
        provider,
        lastIndexedBlock,
        blocksToProcess
      )

      lastIndexedBlock += processedBlocks

      parentPort.postMessage({ processedBlocks })

      if (processedBlocks !== blocksToProcess) {
        chunkSize = Math.floor(chunkSize / 2)
      }

      remainingBlocks -= processedBlocks
    }
  }

  parentPort.postMessage({ processedBlocks: 0 })
})
