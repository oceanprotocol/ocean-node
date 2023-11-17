// import { expect } from 'chai'
// import sinon from 'sinon'
// import fs from 'fs'
// import {
//   getDeployedContractBlock,
//   getNetworkHeight,
//   processBlocks,
//   processEventData
// } from '../../../src/components/Indexer/utils.js'
// import { EVENTS } from '../../../src/utils/constants.js'

// describe('getDeployedContractBlock', () => {
//   it('should return the deployed block for the specified network', async () => {
//     const mockAddressFile = {
//       someKey: { chainId: 1, startBlock: 1000 },
//       otherKey: { chainId: 2, startBlock: 2000 }
//     }
//     const readFileSyncStub = sinon
//       .stub(fs, 'readFileSync')
//       .returns(JSON.stringify(mockAddressFile))
//     process.env.ADDRESS_FILE = 'mockedAddressFile'

//     const result = await getDeployedContractBlock(1)

//     expect(result).to.equal(1000)
//     expect(readFileSyncStub.calledWith('mockedAddressFile', 'utf8')

//     sinon.restore()
//   })

//   it('should return undefined for a network not in the address file', async () => {
//     const mockAddressFile = {
//       someKey: { chainId: 1, startBlock: 1000 },
//       otherKey: { chainId: 2, startBlock: 2000 }
//     }
//     sinon.stub(fs, 'readFileSync').returns(JSON.stringify(mockAddressFile))
//     process.env.ADDRESS_FILE = 'mockedAddressFile'

//     const result = await getDeployedContractBlock(3)

//     expect(result).to.be.undefined

//     sinon.restore()
//   })
// })

// describe('getNetworkHeight', () => {
//   it('should return the network height from the provider', async () => {
//     const mockProvider = { getBlockNumber: sinon.stub().resolves(5000) }

//     const result = await getNetworkHeight(mockProvider)

//     expect(result).to.equal(5000)
//   })
// })

// describe('processBlocks', () => {
//   it('should process the specified number of blocks', async () => {
//     const mockProvider = {
//       getBlock: sinon.stub().resolves({ transactions: ['tx1', 'tx2'] }),
//       getTransactionReceipt: sinon.stub().resolves({ logs: ['log1', 'log2'] })
//     }

//     const result = await processBlocks(mockProvider, 1, 2)

//     expect(result).to.equal(4)
//     expect(mockProvider.getBlock).to.have.been.calledTwice
//     expect(mockProvider.getTransactionReceipt).to.have.been.calledTwice
//   })
// })

// describe('processEventData', () => {
//   let findEventByKeyStub
//   let processMetadataEventsStub
//   let procesExchangeCreatedStub
//   let processExchangeRateChangedStub
//   let procesOrderStartedStub
//   let processTokenUriUpadateStub

//   beforeEach(() => {
//     findEventByKeyStub = sinon.stub().returns({ type: EVENTS.METADATA_CREATED })
//     processMetadataEventsStub = sinon.stub().resolves('METADATA_CREATED')
//     procesExchangeCreatedStub = sinon.stub().resolves('EXCHANGE_CREATED')
//     processExchangeRateChangedStub = sinon.stub().resolves('EXCHANGE_RATE_CHANGED')
//     procesOrderStartedStub = sinon.stub().resolves('ORDER_STARTED')
//     processTokenUriUpadateStub = sinon.stub().resolves('TOKEN_URI_UPDATE')
//   })

//   it('should process metadata events', async () => {
//     const logs: Log[] = [{ topics: ['0x123'] }]

//     const result = await processEventData(logs)

//     expect(result).to.equal('METADATA_CREATED')
//     expect(findEventByKeyStub.calledOnce()).to.be.true
//     expect(processMetadataEventsStub.calledOnce
//   })

//   afterEach(() => {
//     sinon.restore()
//   })
// })
