import { parentPort, workerData } from 'worker_threads'
import { getLastIndexedBlock, getNetworkHeight, processBlocks } from './utils.js'
import { Blockchain } from '../../utils/blockchain.js'

const { network } = workerData
const blockchain = new Blockchain(JSON.parse(process.env.RPCS))
const provider = blockchain.getProvider(network)
console.log('worker for network', network)

async function proccesNetworkData(): Promise<void> {
  let lastIndexedBlock = await getLastIndexedBlock(provider)
  console.log('lastIndexedBlock', lastIndexedBlock)

  const networkHeight = await getNetworkHeight(provider)
  console.log('networkHeight', networkHeight)

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
  console.log('message --', message)
  if (message.method === 'start-crawling') {
    console.log('start-crawling', message.method)
    proccesNetworkData()
  }
})
