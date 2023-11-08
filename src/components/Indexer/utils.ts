import { ethers } from 'ethers'

export const detectDeployedBlock = async (provider: ethers.Provider) => {
  const deployedBlock = await provider.getTransactionReceipt(deployedContractAddress)
    .blockNumber

  return deployedBlock
}

export const getLastIndexedBlock = async (provider: ethers.Provider) => {
  //   const lastIndexedBlocks = getIndexFromDB()
  const lastIndexedBlocks = 0
  //   const lastIndexedBlock = lastIndexedBlocks[network] || 0

  return lastIndexedBlock
}

export const getNetworkHeight = async (provider: ethers.Provider) => {
  const networkHeight = await provider.getBlockNumber()

  return networkHeight
}

export const processBlocks = async (
  provider: ethers.Provider,
  startIndex: number,
  count: number
) => {
  let processedBlocks = 0

  for (let blockNumber = startIndex; blockNumber < startIndex + count; blockNumber++) {
    const block = await provider.getBlock(blockNumber)

    const processedEvents = processBlockEvents(block)

    processedBlocks += processedEvents.length
  }

  return processedBlocks
}

const processBlockEvents = (block: ethers.Block) => {
  const processedEvents = []

  for (const event of block.events) {
    const processedEventData = processEventData(event)

    if (processedEventData) {
      processedEvents.push(processedEventData)
    }
  }

  return processedEvents
}

const processEventData = (event: ethers.LogDescription) => {
  return 'Metadata created'
}
