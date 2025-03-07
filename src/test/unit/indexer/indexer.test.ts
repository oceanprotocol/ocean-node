import { assert, expect } from 'chai'
import { describe, it } from 'mocha'
import { OceanIndexer } from '../../../components/Indexer/index.js'
import { getConfiguration } from '../../../utils/index.js'
import { Database } from '../../../components/database/index.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { RPCS } from '../../../@types/blockchain.js'
import {
  hasValidDBConfiguration,
  isReachableConnection
} from '../../../utils/database.js'
import sinon from 'sinon'
import * as dbUtils from '../../../utils/database.js'

describe('OceanIndexer', () => {
  let oceanIndexer: OceanIndexer
  let mockDatabase: Database
  let config: OceanNodeConfig
  before(async () => {
    config = await getConfiguration(true)
    mockDatabase = await new Database(config.dbConfig)
  })

  it('should start threads and handle worker events', async () => {
    oceanIndexer = new OceanIndexer(mockDatabase, config.supportedNetworks)
    assert(oceanIndexer, 'indexer should not be null')
    expect(oceanIndexer.getDatabase().getConfig()).to.be.equal(mockDatabase.getConfig())
    expect(oceanIndexer.getIndexingQueue().length).to.be.equal(0)
    expect(oceanIndexer.getJobsPool().length).to.be.equal(0)

    if (
      hasValidDBConfiguration(mockDatabase.getConfig()) &&
      (await isReachableConnection(mockDatabase.getConfig().url))
    ) {
      // should be fine, if we have a valid RPC as well
      expect(await oceanIndexer.startThreads()).to.be.equal(true)
    } else {
      // cannot start threads without DB connection
      expect(await oceanIndexer.startThreads()).to.be.equal(false)
    }

    // there are no worker threads available
    expect(oceanIndexer.stopAllThreads()).to.be.equal(false)
  })

  describe('checkAndTriggerReindexing', () => {
    let indexer: OceanIndexer
    let mockDb: Database
    let resetCrawlingSpy: sinon.SinonSpy
    let isReachableStub: sinon.SinonStub

    beforeEach(() => {
      // Create mock database with indexer property
      mockDb = {
        getConfig: () => ({ url: 'http://localhost:9200', dbType: 'elasticsearch' }),
        indexer: {
          getNodeVersion: sinon.stub().resolves(null),
          setNodeVersion: sinon.stub().resolves()
        }
      } as unknown as Database

      const mockNetworks = {
        '8996': {
          chainId: 8996,
          network: '8996',
          rpc: 'http://localhost:8545'
        }
      } as RPCS

      // Mock isReachableConnection to return true
      isReachableStub = sinon.stub(dbUtils, 'isReachableConnection').resolves(true)

      // Create indexer with mock database
      indexer = new OceanIndexer(mockDb, mockNetworks)

      // Spy on resetCrawling method
      resetCrawlingSpy = sinon.spy(indexer, 'resetCrawling')

      // Mock getCurrentVersion method
      sinon.stub(indexer, 'getCurrentVersion' as any).returns('0.2.2')
    })

    afterEach(() => {
      sinon.restore()
    })

    it('should have null version initially', async () => {
      const version = await mockDb.indexer.getNodeVersion()
      assert(version === null, 'Initial version should be null')
    })

    it('should trigger reindexing and set version when version is null', async () => {
      await indexer.checkAndTriggerReindexing()

      assert(resetCrawlingSpy.calledOnce, 'resetCrawling should be called once')
      assert(
        (mockDb.indexer.setNodeVersion as sinon.SinonStub).calledWith('0.2.2'),
        'setNodeVersion should be called with current version'
      )
    })

    it('should trigger reindexing when database version is old', async () => {
      // Set an old version in DB
      ;(mockDb.indexer.getNodeVersion as sinon.SinonStub).resolves('0.2.0')

      await indexer.checkAndTriggerReindexing()

      assert(resetCrawlingSpy.calledOnce, 'resetCrawling should be called once')
      assert(
        (mockDb.indexer.setNodeVersion as sinon.SinonStub).calledWith('0.2.2'),
        'setNodeVersion should be called with new version'
      )
    })

    it('should not trigger reindexing when database version is current', async () => {
      // Set current version in DB
      ;(mockDb.indexer.getNodeVersion as sinon.SinonStub).resolves('0.2.2')

      await indexer.checkAndTriggerReindexing()

      assert(resetCrawlingSpy.notCalled, 'resetCrawling should not be called')
    })

    it('should not proceed if database is not reachable', async () => {
      // Make database unreachable
      isReachableStub.resolves(false)

      await indexer.checkAndTriggerReindexing()

      assert(resetCrawlingSpy.notCalled, 'resetCrawling should not be called')
      assert(
        (mockDb.indexer.setNodeVersion as sinon.SinonStub).notCalled,
        'setNodeVersion should not be called'
      )
    })
  })
})
