import { expect } from 'chai'
import { stub } from 'sinon'
import { describe, it } from 'mocha'
import {
  INDEXER_CRAWLING_EVENT_EMITTER,
  OceanIndexer
} from '../../../components/Indexer/index.js'
import { RPCS } from '../../../@types/blockchain'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment
} from '../../utils/utils.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { Database } from '../../../components/database/index.js'
import { OceanNode } from '../../../OceanNode.js'
import {
  ENVIRONMENT_VARIABLES,
  INDEXER_CRAWLING_EVENTS
} from '../../../utils/constants.js'
import { getConfiguration } from '../../../utils/config.js'
import { Blockchain } from '../../../utils/blockchain.js'
import {
  getNetworkHeight,
  getDeployedContractBlock
} from '../../../components/Indexer/utils.js'
import { homedir } from 'os'
import { DEVELOPMENT_CHAIN_ID } from '../../../utils/address.js'
import { sleep } from '../../../utils/util.js'

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

    // stub(oceanIndexer as any, 'createWorker').returns(mockWorker)

    await oceanIndexer.startThreads()

    // eslint-disable-next-line no-unused-expressions
    expect(mockWorker.postMessage.calledOnceWith({ method: 'start-crawling' })).to.be
      .false
    // eslint-disable-next-line no-unused-expressions
    expect(mockWorker.on.calledThrice).to.be.false
  })
})

describe('OceanIndexer - crawler threads', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: Database
  let oceanNode: OceanNode
  let oceanIndexer: OceanIndexer
  let blockchain: Blockchain

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()
  const chainID = DEVELOPMENT_CHAIN_ID.toString()
  mockSupportedNetworks[chainID].startBlock = 2

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.ADDRESS_FILE],
      [
        JSON.stringify(mockSupportedNetworks),
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
      ]
    )
    envOverrides = await setupEnvironment(null, envOverrides)
    config = await getConfiguration(true)
    db = await new Database(config.dbConfig)

    oceanNode = OceanNode.getInstance(db)
    oceanIndexer = new OceanIndexer(db, mockSupportedNetworks)
    blockchain = new Blockchain(
      mockSupportedNetworks[chainID].rpc,
      mockSupportedNetworks[chainID].chainId
    )

    oceanNode.addIndexer(oceanIndexer)
  })
  it('should start a worker thread and handle RPCS "startBlock"', async () => {
    const netHeight = await getNetworkHeight(blockchain.getProvider())
    const deployBlock = getDeployedContractBlock(mockSupportedNetworks[chainID].chainId)
    const { indexer } = db
    const updatedIndex = await indexer.update(Number(chainID), 1)

    expect(updatedIndex.lastIndexedBlock).to.be.equal(1)

    await oceanIndexer.startThreads()
    INDEXER_CRAWLING_EVENT_EMITTER.addListener(
      INDEXER_CRAWLING_EVENTS.CRAWLING_STARTED,
      (data: any) => {
        const { startBlock, deployedContractBlock, networkHeight } = data
        expect(startBlock).to.be.equal(1)
        expect(deployedContractBlock).to.be.equal(deployBlock)
        expect(networkHeight).to.be.equal(netHeight)
      }
    )
  })
})
