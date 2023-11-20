import { Database } from '../../src/components/database'
import { expect, assert } from 'chai'
import {
  CustomNodeLogger,
  LOG_LEVELS_STR,
  CustomOceanNodesTransport,
  getCustomLoggerForModule,
  LOGGER_MODULE_NAMES,
  defaultConsoleTransport
} from '../../src/utils/logging/Logger'

describe('Database', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('instance Database', async () => {
    expect(database).to.be.instanceOf(Database)
  })
})

describe('DdoDatabase CRUD', () => {
  let database: Database
  const ddo = {
    hashType: 'sha256',
    '@context': ['https://w3id.org/did/v1'],
    id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d7',
    nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
    version: '4.1.0',
    chainId: 137,
    metadata: {
      created: '2022-12-30T08:40:06Z',
      updated: '2022-12-30T08:40:06Z',
      type: 'dataset',
      name: 'DEX volume in details',
      description:
        'Volume traded and locked of Decentralized Exchanges (Uniswap, Sushiswap, Curve, Balancer, ...), daily in details',
      tags: ['index', 'defi', 'tvl'],
      author: 'DEX',
      license: 'https://market.oceanprotocol.com/terms',
      additionalInformation: {
        termsAndConditions: true
      }
    }
  }

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('create ddo', async () => {
    const result = await database.ddo.create(ddo)
    expect(result?.id).to.equal(ddo.id)
  })

  it('retrieve ddo', async () => {
    const result = await database.ddo.retrieve(ddo.id)
    expect(result?.id).to.equal(ddo.id)
  })

  it('update ddo', async () => {
    const newMetadataName = 'new metadata name'
    const result = await database.ddo.update(ddo.id, {
      metadata: {
        name: newMetadataName
      }
    })
    expect(result?.metadata.name).to.equal(newMetadataName)
  })

  it('delete ddo', async () => {
    const result = await database.ddo.delete(ddo.id)
    expect(result?.id).to.equal(ddo.id)
  })
})

describe('NonceDatabase CRUD', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('create nonce', async () => {
    const result = await database.nonce.create('0x123', 0)
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(0)
  })

  it('retrieve nonce', async () => {
    const result = await database.nonce.retrieve('0x123')
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(0)
  })

  it('update nonce', async () => {
    const result = await database.nonce.update('0x123', 1)
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(1)
  })

  it('delete nonce', async () => {
    const result = await database.nonce.delete('0x123')
    expect(result?.id).to.equal('0x123')
    expect(result?.nonce).to.equal(1)
  })
})

describe('IndexerDatabase CRUD', () => {
  let database: Database

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
  })

  it('create indexer', async () => {
    const result = await database.indexer.create({
      id: 'chain1',
      last_block: 0
    })
    expect(result?.id).to.equal('chain1')
    expect(result?.last_block).to.equal(0)
  })

  it('retrieve indexer', async () => {
    const result = await database.indexer.retrieve('chain1')
    expect(result?.id).to.equal('chain1')
    expect(result?.last_block).to.equal(0)
  })

  it('update indexer', async () => {
    const result = await database.indexer.update('chain1', {
      last_block: 1
    })
    expect(result?.id).to.equal('chain1')
    expect(result?.last_block).to.equal(1)
  })

  it('delete indexer', async () => {
    const result = await database.indexer.delete('chain1')
    expect(result?.id).to.equal('chain1')
    expect(result?.last_block).to.equal(1)
  })
})

describe('LogDatabase CRUD', () => {
  let database: Database
  let logger: CustomNodeLogger
  const logEntry = {
    timestamp: Date.now(),
    level: 'info',
    message: `Test log message ${Date.now()}`,
    meta: 'Test meta information'
  }
  let logId: string // Variable to store the ID of the created log entry

  before(async () => {
    const dbConfig = {
      url: 'http://localhost:8108/?apiKey=xyz'
    }
    database = await new Database(dbConfig)
    // Initialize logger with the custom transport that writes to the LogDatabase
    const customLogTransport = new CustomOceanNodesTransport({ dbInstance: database })
    logger = getCustomLoggerForModule(
      LOGGER_MODULE_NAMES.HTTP,
      LOG_LEVELS_STR.LEVEL_INFO, // Info level
      defaultConsoleTransport // console only Transport
    )
    logger.addTransport(customLogTransport)
  })

  it('insert log', async () => {
    const result = await database.logs.insertLog(logEntry)
    console.log('insert log', result)
    expect(result).to.include.keys('id', 'timestamp', 'level', 'message', 'meta')
    logId = result?.id // Save the auto-generated id for further operations
  })

  it('retrieve log', async () => {
    const result = await database.logs.retrieveLog(logId)
    console.log('result', result)
    expect(result?.id).to.equal(logId)
    expect(result?.level).to.equal(logEntry.level)
    expect(result?.message).to.equal(logEntry.message)
    expect(result?.meta).to.equal(logEntry.meta)
  })

  it('should save a log in the database when a log event is triggered', async () => {
    const newLogEntry = {
      timestamp: Date.now(),
      level: 'info',
      message: `NEW Test log message ${Date.now()}`,
      meta: 'Test meta information'
    }
    // Trigger a log event which should be saved in the database
    logger.log(newLogEntry.level, newLogEntry.message)

    // Wait for the log to be written to the database
    await new Promise((resolve) => setTimeout(resolve, 1000)) // Delay to allow log to be processed

    // Define the time frame for the log retrieval
    const startTime = new Date(Date.now() - 10000) // 10 seconds ago
    const endTime = new Date() // current time

    // Retrieve the latest log entry
    const logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 1)
    console.log('logs', logs)

    expect(logs?.length).to.equal(1)
    expect(logs?.[0].id).to.equal(String(Number(logId) + 1))
    expect(logs?.[0].level).to.equal(newLogEntry.level)
    expect(logs?.[0].message).to.equal(newLogEntry.message)
  })

  it('should save a log in the database when a log.logMessage is called', async () => {
    const newLogEntry = {
      timestamp: Date.now(),
      level: 'info',
      message: `logMessage: Test log message ${Date.now()}`,
      meta: 'Test meta information'
    }
    // Trigger a log event which should be saved in the database
    logger.logMessage(newLogEntry.message)

    // Wait for the log to be written to the database
    await new Promise((resolve) => setTimeout(resolve, 1000)) // Delay to allow log to be processed

    // Define the time frame for the log retrieval
    const startTime = new Date(Date.now() - 10000) // 10 seconds ago
    const endTime = new Date() // current time

    // Retrieve the latest log entry
    const logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 1)
    console.log('logs', logs)

    expect(logs?.length).to.equal(1)
    expect(logs?.[0].id).to.equal(String(Number(logId) + 2))
    expect(logs?.[0].level).to.equal(newLogEntry.level)
    expect(logs?.[0].message).to.equal(newLogEntry.message)
  })

  it('should save a log in the database when a log.logMessageWithEmoji is called', async () => {
    const newLogEntry = {
      timestamp: Date.now(),
      level: 'info',
      message: `logMessageWithEmoji: Test log message ${Date.now()}`,
      meta: 'Test meta information'
    }
    // Trigger a log event which should be saved in the database
    logger.logMessageWithEmoji(newLogEntry.message)

    // Wait for the log to be written to the database
    await new Promise((resolve) => setTimeout(resolve, 1000)) // Delay to allow log to be processed

    // Define the time frame for the log retrieval
    const startTime = new Date(Date.now() - 10000) // 10 seconds ago
    const endTime = new Date() // current time

    // Retrieve the latest log entry
    const logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 1)
    console.log('logs', logs)

    expect(logs?.length).to.equal(1)
    expect(logs?.[0].id).to.equal(String(Number(logId) + 3))
    expect(logs?.[0].level).to.equal(newLogEntry.level)
    assert(logs?.[0].message)
  })
})
