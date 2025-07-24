import { Database } from '../../components/database/index.js'
import { expect, assert } from 'chai'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  configureCustomDBTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { getConfiguration } from '../../utils/index.js'

let previousConfiguration: OverrideEnvConfig[]

describe('LogDatabase CRUD', () => {
  let database: Database
  let logger: CustomNodeLogger
  const logEntry = {
    timestamp: Date.now(),
    level: 'debug',
    message: `Test log message ${Date.now()}`,
    moduleName: 'testModule-1',
    meta: 'Test meta information'
  }
  let logId: string // Variable to store the ID of the created log entry

  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.LOG_DB], ['true'])
    )
    const { dbConfig } = await getConfiguration(true)
    database = await Database.init(dbConfig)
    // Initialize logger with the custom transport that writes to the LogDatabase
    logger = getCustomLoggerForModule(
      LOGGER_MODULE_NAMES.HTTP,
      LOG_LEVELS_STR.LEVEL_DEBUG
    )
    // normally this is only added on production environments
    logger = configureCustomDBTransport(database, logger)
  })

  it('insert log', async () => {
    const result = await database.logs.insertLog(logEntry)
    expect(result).to.include.keys('timestamp', 'level', 'message', 'moduleName', 'meta')
    logId = result?.id // Save the auto-generated id for further operations
  })

  it('retrieve log', async () => {
    const result = await database.logs.retrieveLog(logId)
    expect(result?.level).to.equal(logEntry.level)
    expect(result?.message).to.equal(logEntry.message)
    expect(result?.moduleName).to.equal(logEntry.moduleName)
    expect(result?.meta).to.equal(logEntry.meta)
  })

  it('should save a log in the database when a log event is triggered', async () => {
    const newLogEntry = {
      timestamp: Date.now(),
      level: 'debug',
      message: `NEW Test log message ${Date.now()}`
    }
    // Trigger a log event which should be saved in the database
    logger.log(newLogEntry.level, newLogEntry.message)
    // Wait for the log to be written to the database
    await new Promise((resolve) => setTimeout(resolve, 500)) // Delay to allow log to be processed

    // Define the time frame for the log retrieval
    const startTime = new Date(Date.now() - 2500) // 2.5 seconds ago
    const endTime = new Date() // current time

    // Retrieve the latest log entries
    let logs = await database.logs.retrieveMultipleLogs(
      startTime,
      endTime,
      200,
      LOGGER_MODULE_NAMES.HTTP,
      LOG_LEVELS_STR.LEVEL_DEBUG
    )
    if (logs.length > 0) {
      logs = logs.filter((log) => log.message === newLogEntry.message)

      expect(logs.length).to.equal(1)
      expect(Number(logs[0].id)).to.greaterThan(Number(logId))
      expect(logs[0].level).to.equal(newLogEntry.level)
      expect(logs[0].message).to.equal(newLogEntry.message)
      expect(logs[0].moduleName).to.equal('HTTP')
    }
  })

  it('should save a log in the database when a log.logMessage is called', async () => {
    const newLogEntry = {
      timestamp: Date.now(),
      level: 'debug',
      message: `logMessage: Test log message ${Date.now()}`,
      moduleName: 'testModule-3',
      meta: 'Test meta information'
    }
    // Trigger a log event which should be saved in the database
    logger.logMessage(newLogEntry.message)

    // Wait for the log to be written to the database
    await new Promise((resolve) => setTimeout(resolve, 500)) // Delay to allow log to be processed

    // Define the time frame for the log retrieval
    const startTime = new Date(Date.now() - 2500) // 2.5 seconds ago
    const endTime = new Date() // current time

    // Retrieve the latest log entry
    let logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 200)
    logs = logs.filter((log) => log.message === newLogEntry.message)

    if (logs.length > 0) {
      expect(logs.length).to.equal(1)
      expect(Number(logs[0].id)).to.greaterThan(Number(logId))
      expect(logs[0].level).to.equal(newLogEntry.level)
      expect(logs[0].message).to.equal(newLogEntry.message)
      expect(logs[0].moduleName).to.equal('HTTP')
    }
  })

  it('should save a log in the database when a log.logMessageWithEmoji is called', async () => {
    const newLogEntry = {
      timestamp: Date.now(),
      level: 'debug',
      message: `logMessageWithEmoji: Test log message ${Date.now()}`,
      moduleName: 'testModule-4',
      meta: 'Test meta information'
    }
    // Trigger a log event which should be saved in the database
    logger.logMessageWithEmoji(newLogEntry.message)

    // Wait for the log to be written to the database
    await new Promise((resolve) => setTimeout(resolve, 500)) // Delay to allow log to be processed

    // Define the time frame for the log retrieval
    const startTime = new Date(Date.now() - 2500) // 2.5 seconds ago
    const endTime = new Date() // current time

    // we cannot predict the amount of logs written on DB (Typesense adds tons on its own), so we need:
    // 1 ) set a smaller interval
    // 2 ) retrieve a bigger number of logs
    // 3 ) filter the appropriate message
    // Retrieve the latest log entry
    let logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 200)
    logs = logs.filter((log) => log.message.includes(newLogEntry.message))

    if (logs.length > 0) {
      expect(logs.length).to.equal(1)
      expect(Number(logs[0].id)).to.greaterThan(Number(logId))
      expect(logs[0].level).to.equal(newLogEntry.level)
      assert(logs[0].message)
      expect(logs[0].moduleName).to.equal('HTTP')
    }
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})

describe('LogDatabase retrieveMultipleLogs with specific parameters', () => {
  let database: Database
  // Assume start and end times are defined to bracket your test logs
  const startTime = new Date(Date.now() - 10000) // 10 seconds ago
  const endTime = new Date() // now

  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.LOG_DB], ['true'])
    )

    const { dbConfig } = await getConfiguration(true)
    database = await Database.init(dbConfig)
  })

  it('should retrieve logs with a specific moduleName', async () => {
    const moduleName = 'testModule-1'
    const logs = await database.logs.retrieveMultipleLogs(
      startTime,
      endTime,
      10,
      moduleName
    )
    expect(logs).to.satisfy((logs: any[]) =>
      logs.every((log) => log.moduleName === moduleName)
    )
  })

  it('should retrieve logs with a specific level', async () => {
    const level = 'debug'
    const logs = await database.logs.retrieveMultipleLogs(
      startTime,
      endTime,
      10,
      undefined,
      level
    )
    expect(logs).to.satisfy((logs: any[]) => logs.every((log) => log.level === level))
  })

  it('should retrieve logs with both a specific moduleName and level', async () => {
    const moduleName = 'testModule-1'
    const level = 'debug'
    const logs = await database.logs.retrieveMultipleLogs(
      startTime,
      endTime,
      10,
      moduleName,
      level
    )
    expect(logs).to.satisfy((logs: any[]) =>
      logs.every((log) => log.moduleName === moduleName && log.level === level)
    )
  })

  it('should not retrieve logs when no logs match the moduleName', async () => {
    const logs = await database.logs.retrieveMultipleLogs(
      startTime,
      endTime,
      10,
      'nonExistentModule'
    )
    assert.isEmpty(logs, 'Expected logs to be empty')
  })

  describe('SHould delete a single log from LogDatabase', () => {
    let database: Database
    const logEntry = {
      timestamp: Date.now(),
      level: 'debug',
      message: 'Test log message for single deletion',
      moduleName: 'testModule-2',
      meta: 'Test meta information for single deletion'
    }
    let singleLogId: string

    before(async () => {
      const { dbConfig } = await getConfiguration(true)
      database = await Database.init(dbConfig)
    })

    it('should insert a log for deletion', async () => {
      const result = await database.logs.insertLog(logEntry)
      expect(result).to.include.keys(
        'id',
        'timestamp',
        'level',
        'message',
        'moduleName',
        'meta'
      )
      singleLogId = result?.id
    })

    it('should delete a single log', async () => {
      await database.logs.delete(singleLogId)

      // Attempt to retrieve the deleted log
      const deletedLog = await database.logs.retrieveLog(singleLogId)
      expect(!deletedLog, 'Deleted log should not exist')
    })
  })

  it('should not retrieve logs when no logs match the level', async () => {
    const logs = await database.logs.retrieveMultipleLogs(
      startTime,
      endTime,
      10,
      undefined,
      'nonExistentLevel'
    )
    assert.isEmpty(logs, 'Expected logs to be empty')
  })

  it('should return an error or empty result for invalid startTime and endTime', async () => {
    const invalidTime = new Date('invalid date')
    try {
      const logs = await database.logs.retrieveMultipleLogs(invalidTime, invalidTime, 10)
      assert.isEmpty(logs, 'Expected logs to be empty')
    } catch (error) {
      assert(error, 'Expected an error for invalid date inputs')
    }
  })

  it('should return an empty array for negative maxLogs', async () => {
    const logs = await database.logs.retrieveMultipleLogs(startTime, endTime, -1)
    assert.isEmpty(logs, 'Expected logs to be empty')
  })

  it('should retrieve a maximum of one log when maxLogs is set to 1', async () => {
    const logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 1)
    // check if the length of logs is 1 or less
    expect(logs.length).to.be.at.most(1)
  })

  it('should retrieve no logs when maxLogs is set to 0', async () => {
    const logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 0)
    assert.isEmpty(logs, 'Expected logs to be empty')
  })

  // Performance test
  it('should perform within acceptable limits', async function () {
    this.timeout(5000) // Extend default Mocha test timeout

    const startPerfTime = process.hrtime()
    await database.logs.retrieveMultipleLogs(startTime, endTime, 10)
    const endPerfTime = process.hrtime(startPerfTime)

    // Convert [seconds, nanoseconds] to milliseconds
    const elapsedTimeInMs = endPerfTime[0] * 1000 + endPerfTime[1] / 1e6
    expect(elapsedTimeInMs).to.be.below(1000) // threshold
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})

describe('LogDatabase deleteOldLogs', () => {
  let database: Database
  const oldLogEntry = {
    timestamp: new Date().getTime() - 31 * 24 * 60 * 60 * 1000, // 31 days ago
    level: 'debug',
    message: 'Old log message for deletion test',
    moduleName: 'testModule-1',
    meta: 'Test meta information'
  }
  const recentLogEntry = {
    timestamp: new Date().getTime(), // current time
    level: 'debug',
    message: 'Recent log message not for deletion',
    moduleName: 'testModule-1',
    meta: 'Test meta information'
  }

  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.LOG_DB], ['true'])
    )
    const { dbConfig } = await getConfiguration(true)
    database = await Database.init(dbConfig)
  })

  it('should insert an old log and a recent log', async () => {
    const oldLogResult = await database.logs.insertLog(oldLogEntry)
    expect(oldLogResult).to.include.keys(
      'timestamp',
      'level',
      'message',
      'moduleName',
      'meta'
    )

    const recentLogResult = await database.logs.insertLog(recentLogEntry)
    expect(recentLogResult).to.include.keys(
      'timestamp',
      'level',
      'message',
      'moduleName',
      'meta'
    )
  })

  it('should delete logs older than 30 days', async () => {
    const deleted = await database.logs.deleteOldLogs()
    if (deleted > 0) {
      // IF DB is new there are no logs older than 30 days!!
      // assert(deleted > 0, 'could not delete old logs')

      // Adjust the time window to ensure we don't catch the newly inserted log
      let startTime = new Date(oldLogEntry.timestamp)
      let endTime = new Date()
      let logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 100)

      // Check that the old log is not present, but the recent one is
      const oldLogPresent = logs.some((log) => log.message === oldLogEntry.message)
      assert(oldLogPresent === false, 'Old logs are still present')

      // since we have many logs going to DB by default, we need to re-frame the timestamp to grab it
      startTime = new Date(recentLogEntry.timestamp - 1000)
      endTime = new Date(recentLogEntry.timestamp + 1000)
      logs = await database.logs.retrieveMultipleLogs(startTime, endTime, 100)
      const recentLogPresent = logs.some((log) => log.message === recentLogEntry.message)
      assert(recentLogPresent === true, 'Recent logs are not present')
    } else
      assert(
        deleted === 0,
        'could not delete old logs (30 days +), DB is probably recent!'
      )
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
describe('LogDatabase retrieveMultipleLogs with pagination', () => {
  let database: Database
  const logCount = 10 // Total number of logs to insert and also the limit for logs per page

  before(async () => {
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.LOG_DB], ['true'])
    )
    const { dbConfig } = await getConfiguration(true)
    database = await Database.init(dbConfig)

    // Insert multiple log entries to ensure there are enough logs for pagination
    for (let i = 0; i < logCount; i++) {
      await database.logs.insertLog({
        timestamp: Date.now(),
        level: 'info',
        message: `Test log message ${Date.now()}`,
        moduleName: `testModule-${i}`,
        meta: `Test meta information ${i}`
      })
    }
  })

  it('should retrieve logs limited by maxLogs', async () => {
    const logs = await database.logs.retrieveMultipleLogs(
      new Date(Date.now() - 10000), // 10 seconds ago
      new Date(), // now
      5 // Limit the number of logs to 5
    )
    expect(logs.length).to.be.at.most(5)
  })

  it('should retrieve the total number of log entries', async () => {
    const numLogs = await database.logs.getLogsCount()
    expect(numLogs).to.be.at.least(logCount)
  })

  it('should retrieve logs for a specific page', async () => {
    const LOGS_PER_PAGE = 5
    const logsPage1 = await database.logs.retrieveMultipleLogs(
      new Date(Date.now() - 10000), // 10 seconds ago
      new Date(), // now
      LOGS_PER_PAGE, // Limit the number of logs to 5 for pagination
      undefined,
      undefined,
      1 // Page 1
    )
    const logsPage2 = await database.logs.retrieveMultipleLogs(
      new Date(Date.now() - 10000), // 10 seconds ago
      new Date(), // now
      LOGS_PER_PAGE, // Limit the number of logs to 5 for pagination
      undefined,
      undefined,
      2 // Page 2
    )
    // make sure we have enough logs for 2 pages
    const logsCount = await database.logs.getLogsCount()
    // Ensure that the logs on page 2 are different from those on page 1 if logsPage2 is not empty
    if (logsCount > LOGS_PER_PAGE && logsPage2.length > 0) {
      expect(logsPage1[0].id).to.not.equal(logsPage2[0].id)
    } else {
      assert.isEmpty(logsPage2, 'Expected logs to be empty')
    }
  })

  it('should return empty results for a non-existent page', async () => {
    const nonExistentPage = 30000 // Assuming this page doesn't exist
    const logs = await database.logs.retrieveMultipleLogs(
      new Date(Date.now() - 10000), // 10 seconds ago
      new Date(), // now
      5, // Limit the number of logs to 5 for pagination
      undefined,
      undefined,
      nonExistentPage
    )
    assert.isEmpty(logs, 'Expected logs to be empty')
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
