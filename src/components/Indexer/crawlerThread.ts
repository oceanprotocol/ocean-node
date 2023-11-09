import { parentPort, workerData } from 'worker_threads'
import { getLastIndexedBlock, getNetworkHeight, processBlocks } from './utils'

const { network, provider } = workerData

console.log('worker for network', network)

async function proccesNetworkData(): Promise<void> {
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
}

parentPort.on('message', (message) => {
  if (message.method === 'start-crawling') {
    proccesNetworkData()
  }
})
