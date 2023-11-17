import { parentPort, workerData } from 'worker_threads'
import { getDeployedContractBlock, getNetworkHeight, processBlocks } from './utils.js'
import { Blockchain } from '../../utils/blockchain.js'
import { SupportedNetwork } from '../../@types/blockchain.js'

interface ThreadData {
  rpcDetails: SupportedNetwork
  lastIndexedBlock: number
}

const { rpcDetails, lastIndexedBlock } = workerData as ThreadData

const blockchain = new Blockchain(rpcDetails.rpc, rpcDetails.chainId)
const provider = blockchain.getProvider()

export async function proccesNetworkData(): Promise<void> {
  const networkHeight = await getNetworkHeight(provider)

  const deployedBlock = await getDeployedContractBlock(rpcDetails.chainId)

  let startBlock =
    lastIndexedBlock && lastIndexedBlock > deployedBlock
      ? lastIndexedBlock
      : deployedBlock

  console.log(
    `network: ${rpcDetails.network} Start block ${startBlock} network height ${networkHeight}`
  )

  if (networkHeight > startBlock) {
    let { chunkSize } = rpcDetails
    let remainingBlocks = networkHeight - startBlock
    console.log(`network: ${rpcDetails.network} Remaining blocks ${remainingBlocks} `)

    while (remainingBlocks > 0) {
      const blocksToProcess = Math.min(chunkSize, remainingBlocks)

      const processedBlocks = await processBlocks(provider, startBlock, blocksToProcess)

      startBlock += processedBlocks

      parentPort.postMessage({
        method: 'store-last-indexed-block',
        network: rpcDetails.chainId,
        data: startBlock
      })

      if (processedBlocks !== blocksToProcess) {
        chunkSize = Math.floor(chunkSize / 2)
        console.log(`network: ${rpcDetails.network} Reducing chink size  ${chunkSize} `)
      }

      remainingBlocks -= processedBlocks
    }
  }

  parentPort.postMessage({ event: 'metadata-created' })
}

parentPort.on('message', (message) => {
  console.log('message --', message)
  if (message.method === 'start-crawling') {
    proccesNetworkData()
  }
})
