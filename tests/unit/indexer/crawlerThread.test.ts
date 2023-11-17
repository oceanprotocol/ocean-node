// import { expect } from 'chai'
// import sinon from 'sinon'
// import { proccesNetworkData } from '../../../src/components/Indexer/crawlerThread'
// import * as utils from '../../../src/components/Indexer/utils'
// import { Blockchain } from '../../../src/utils/blockchain'

// describe('proccesNetworkData', () => {
//   before(() => {
//     global.parentPort = {
//       on: sinon.stub(),
//       postMessage: sinon.stub()
//     }

//     global.workerData = {
//       network: 1,
//       lastIndexedBlock: 1000
//     }

//     const getBlockNumberStub = sinon.stub().returns(5000)

//     // Create a stub for getProvider
//     // const getProviderStub = sinon.stub(Blockchain.prototype, 'getProvider').returns({
//     //   getBlockNumber: getBlockNumberStub
//     // })

//     sinon.stub(utils, 'getDeployedContractBlock').resolves(500)
//     sinon.stub(utils, 'getNetworkHeight').resolves(10000)
//     sinon.stub(utils, 'processBlocks').resolves(100)
//   })

//   after(() => {
//     sinon.restore()
//   })

//   it('should call the necessary functions and post messages to parentPort', async () => {
//     await proccesNetworkData()

//     expect((utils.getNetworkHeight as any).calledOnce).to.be.true
//     expect(utils.getDeployedContractBlock.calledWith(sinon.match(1)))

//     const processBlocksSpy = sinon.spy(utils, 'processBlocks')
//     const getDeployedContractBlock = sinon.spy(utils, 'getDeployedContractBlock')

//     // Your test logic here

//     // Verify the spy or mock was called with the expected arguments
//     expect(
//       processBlocksSpy.calledWith(sinon.match.any, sinon.match.number, sinon.match.number)
//     ).to.be.true

//     expect(getDeployedContractBlock.calledWith(sinon.match.number)).to.be.true

//     expect(
//       global.parentPort.postMessage.calledWith(
//         sinon.match({
//           processedBlocks: 100
//         })
//       )
//     )

//     expect(
//       global.parentPort.postMessage.calledWith(
//         sinon.match({
//           event: 'metadata-created'
//         })
//       )
//     )
//   })
// })

// describe('Utility Functions', () => {
//   it('getDeployedContractBlock should return a number', async () => {
//     const result = await utils.getDeployedContractBlock(1)
//     expect(result).to.equal(500)
//   })

//   it('getNetworkHeight should return a number', async () => {
//     // const result = await utils.getNetworkHeight()
//     // expect(result).to.equal(10000)
//   })

//   it('processBlocks should return a number', async () => {
//     // const result = await utils.processBlocks(
//     // //   sinon.match.any,
//     //   sinon.match.number,
//     //   sinon.match.number
//     // )
//     // expect(result).to.equal(100)
//   })
// })
