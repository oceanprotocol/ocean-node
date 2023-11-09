import { ethers } from 'ethers'

export const getLastIndexedBlock = async (provider: ethers.Provider) => {
  //   const lastIndexedBlocks = getIndexFromDB() once done
  const lastIndexedBlocks = 0
  //   const lastIndexedBlock = lastIndexedBlocks[network] || 0

  return lastIndexedBlocks
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

    const processedEvents = await processBlockEvents(provider, block)

    processedBlocks += processedEvents.length
  }

  return processedBlocks
}

const processBlockEvents = async (provider: ethers.Provider, block: ethers.Block) => {
  const processedEvents = []
  console.log(`Block number: ${block.number}`)
  for (const transaction of block.transactions) {
    console.log(`Transaction hash: ${transaction}`)
    const receipt = await provider.getTransactionReceipt(transaction)
    const processedEventData = processEventData(receipt.logs)
    if (processedEventData) {
      processedEvents.push(processedEventData)
    }
  }
  return processedEvents
}

const processEventData = (logs: readonly ethers.Log[]) => {
  for (const log of logs) {
    const eventFragment = ethers.EventFragment.from(log.topics[0])

    console.log(`Event name: ${eventFragment.name}`)

    if (eventFragment.name === 'METADATA-CREATED') {
      //   const decodedData = ethers.defaultAbiCoder.decode(eventFragment.inputs, log.data)
      //   console.log(`Event data: ${JSON.stringify(decodedData)}`)
      return 'Metadata created'
    }
  }

  return null
}
