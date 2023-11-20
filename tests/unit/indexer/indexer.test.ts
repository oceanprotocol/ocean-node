import { expect } from 'chai'
import { stub } from 'sinon'
import { describe, it } from 'mocha'
import { OceanIndexer } from '../../../src/components/Indexer' // Adjust the import path accordingly
import { RPCS } from '../../../src/@types/blockchain'

class MockDatabase {
  indexer = {
    retrieve: stub(),
    update: stub()
  }
}

const mockSupportedNetworks: RPCS = {
  '1': { chainId: 1, network: 'mainnet', rpc: 'https://mainnet.rpc', chunkSize: 1000 },
  '2': { chainId: 2, network: 'testnet', rpc: 'https://testnet.rpc', chunkSize: 500 }
}

describe('OceanIndexer', () => {
  it('should start threads and handle worker events', async () => {
    const mockDatabase = new MockDatabase()
    const oceanIndexer = new OceanIndexer(mockDatabase as any, mockSupportedNetworks)

    const mockWorker = {
      on: stub(),
      postMessage: stub()
    }

    stub(oceanIndexer as any, 'startThreads').callsFake(() => {
      oceanIndexer.updateLastIndexedBlockNumber = stub()
      oceanIndexer.getLastIndexedBlock = stub().resolves(0)
      oceanIndexer.startThreads = async () => {
        try {
          const network = '1'

          mockWorker.on
            .withArgs('message')
            .callArgWith(1, { method: 'store-last-indexed-block', network, data: 42 })

          mockWorker.on.withArgs('error').callArgWith(1, new Error('Worker error'))

          mockWorker.on.withArgs('exit').callArgWith(1, 0)

          await oceanIndexer.startThreads()
        } catch (error) {
          console.error(error)
        }
      }
    })

    stub(oceanIndexer as any, 'createWorker').returns(mockWorker)

    await oceanIndexer.startThreads()

    // eslint-disable-next-line no-unused-expressions
    expect(mockWorker.postMessage.calledOnceWith({ method: 'start-crawling' })).to.be.true
    // eslint-disable-next-line no-unused-expressions
    expect(mockWorker.on.calledThrice).to.be.true
  })
})
