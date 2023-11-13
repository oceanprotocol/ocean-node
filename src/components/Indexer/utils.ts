import { ethers } from 'ethers'
import fs from 'fs'
import { homedir } from 'os'
import { EVENTS, EVENT_HASHES } from '../../utils/constants.js'
import { NetworkEvent } from '../../@types/blockchain.js'

export const getDeployedContractBlock = async (network: number) => {
  let deployedBlock: number
  const addressFile = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.readFileSync(
      process.env.ADDRESS_FILE ||
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
      'utf8'
    )
  )
  const networkKeys = Object.keys(addressFile)
  networkKeys.forEach((key) => {
    if (addressFile[key].chainId === network) {
      deployedBlock = addressFile[key].startBlock
    }
  })
  return deployedBlock
}

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
  for (const transaction of block.transactions) {
    const receipt = await provider.getTransactionReceipt(transaction)
    // console.log(`receipt: `, receipt)
    const processedEventData = await processEventData(provider, receipt.logs)
    if (processedEventData) {
      processedEvents.push(processedEventData)
    }
  }
  return processedEvents
}

function findEventByKey(keyToFind: string): NetworkEvent {
  for (const [key, value] of Object.entries(EVENT_HASHES)) {
    if (key === keyToFind) {
      console.log(`Found event with key '${key}':`, value)
      return value
    }
  }
  console.log(`Event with key '${keyToFind}' not found`)
  return null
}

const processEventData = async (
  provider: ethers.Provider,
  logs: readonly ethers.Log[]
) => {
  if (logs.length > 0) {
    for (const log of logs) {
      console.log(`receipt logs: `, log.topics[0])
      console.log(EVENT_HASHES)
      const event = findEventByKey(log.topics[0])
      if (event && event.type === EVENTS.METADATA_CREATED) return 'Metadata created'
    }
  }

  return null
}
