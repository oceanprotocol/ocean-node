// import { expect } from 'chai'
// import sinon from 'sinon'
// import { OceanIndexer } from '../../../src/components/Indexer'

// describe('OceanIndexer', () => {
//   let oceanIndexer
//   let dbMock
//   let blockchainMock

//   beforeEach(() => {
//     dbMock = {
//       indexer: {
//         retrieve: sinon.stub().resolves({ lastIndexedBlock: 1000 }),
//         update: sinon.stub().resolves(2000)
//       }
//     }
//     oceanIndexer = new OceanIndexer(dbMock, [1, 2], blockchainMock)
//   })

//   afterEach(() => {
//     sinon.restore()
//   })

//   it('should start threads for each supported network', () => {
//     const workerStub = {
//       on: sinon.stub(),
//       postMessage: sinon.stub()
//     }
//     const workerConstructorStub = sinon.stub(global, 'Worker').returns(workerStub)

//     oceanIndexer.startThreads()

//     expect(workerConstructorStub).to.have.been.calledTwice
//     expect(workerStub.postMessage).to.have.been.calledTwice
//     expect(workerStub.postMessage).to.have.been.calledWith({ method: 'start-crawling' })
//   })

//   it('should handle worker messages and update last indexed block', () => {
//     const workerStub = {
//       on: sinon.stub(),
//       postMessage: sinon.stub()
//     }
//     sinon.stub(global, 'Worker').returns(workerStub)

//     oceanIndexer.startThreads()
//     const messageHandler = workerStub.on.firstCall.args[1] // Get the message handler

//     messageHandler({ method: 'store-last-indexed-block', network: 1, data: 1500 })

//     expect(dbMock.indexer.update).to.have.been.calledWith(1, 1500)
//   })

//   it('should handle worker errors', () => {
//     const workerStub = {
//       on: sinon.stub(),
//       postMessage: sinon.stub()
//     }
//     sinon.stub(global, 'Worker').returns(workerStub)

//     oceanIndexer.startThreads()
//     const errorHandler = workerStub.on.withArgs('error').firstCall.args[1] // Get the error handler

//     errorHandler(new Error('Worker error'))
//   })

//   it('should handle worker exits', () => {
//     const workerStub = {
//       on: sinon.stub(),
//       postMessage: sinon.stub()
//     }
//     sinon.stub(global, 'Worker').returns(workerStub)

//     oceanIndexer.startThreads()
//     const exitHandler = workerStub.on.withArgs('exit').firstCall.args[1] // Get the exit handler

//     exitHandler(0)
//   })
// })
