import { ethers } from 'ethers'
import { expect } from 'chai'
import fs from 'fs'
import { homedir } from 'os'
import { EVENTS } from '../../src/utils/constants.js'
import {
  getDeployedContractBlock,
  getNetworkHeight,
  processBlocks
  //   processBlockEvents,
  //   findEventByKey,
  //   processEventData,
  //   processMetadataEvents,
  //   procesExchangeCreated,
  //   processExchangeRateChanged,
  //   procesOrderStarted,
  //   processTokenUriUpadate
} from '../../src/components/Indexer/utils'

describe('getDeployedContractBlock', () => {
  it('should return the deployed block for the given network', async () => {
    const network = 1
    const addressFile = JSON.parse(
      fs.readFileSync(`${homedir}/.ocean/ocean-contracts/artifacts/address.json`, 'utf8')
    )
    const deployedBlock = addressFile[network].startBlock
    const actualDeployedBlock = await getDeployedContractBlock(network)

    expect(actualDeployedBlock).to.equal(deployedBlock)
  })

  it('should throw an error if the address file is not found', async () => {
    const network = 1
    process.env.ADDRESS_FILE = ''
    await expect(getDeployedContractBlock(network)).to.be.rejectedWith(
      'ADDRESS_FILE not found'
    )
  })
})

// describe('getLastIndexedBlock', () => {
//   it('should return the last indexed block for the given network', async () => {
//     const provider = ethers.getDefaultProvider()
//     const lastIndexedBlock = await getLastIndexedBlock(provider)

//     expect(lastIndexedBlock).to.be.a.number
//   })
// })

// describe('getNetworkHeight', () => {
//   it('should return the network height', async () => {
//     const provider = ethers.getDefaultProvider()
//     const networkHeight = await getNetworkHeight(provider)

//     expect(networkHeight).to.be.a.number
//   })
// })

// describe('processBlocks', () => {
//   it('should process the given number of blocks', async () => {
//     const provider = ethers.getDefaultProvider()
//     const startIndex = 1000
//     const count = 100
//     const processedBlocks = await processBlocks(provider, startIndex, count)

//     expect(processedBlocks).to.equal(count)
//   })
// })

// describe('processBlockEvents', () => {
//   it('should process the events in the given block', async () => {
//     const provider = ethers.getDefaultProvider()
//     const block = await provider.getBlock(1000)
//     const processedEvents = await processBlockEvents(provider, block)

//     expect(processedEvents).to.be.an('array')
//   })
// })

// describe('findEventByKey', () => {
//   it('should return the event with the given key', () => {
//     const keyToFind = '0x9458647365c67324704eb848764bbfc86f3873841b0d8b47a083f6f6e1da3f84'
//     const event = findEventByKey(keyToFind)

//     expect(event.type).to.equal(EVENTS.TOKEN_URI_UPDATE)
//   })

//   it('should return null if the event is not found', () => {
//     const keyToFind = '0x1234567890abcdef1234567890abcdef12345678'
//     const event = findEventByKey(keyToFind)

//     expect(event).to.be.null
//   })
// })

// describe('processMetadataEvents', () => {
//   it('should return the correct event type', async () => {
//     const provider = ethers.getDefaultProvider()
//     const logs = await provider.getBlock(1000).transactions[0].receipt.logs
//     const eventData = await processEventData(provider, logs)
//     const { type } = eventData

//     expect(type).to.equal(EVENTS.METADATA_CREATED)
//   })
// })
