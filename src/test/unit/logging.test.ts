import { ENVIRONMENT_VARIABLES } from '../../utils/index.js'

import { expect } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  sleep,
  tearDownEnvironment
} from '../utils/utils.js'
import {
  CustomOceanNodesTransport,
  MAX_LOGGER_INSTANCES,
  USE_DB_TRANSPORT,
  configureCustomDBTransport,
  getLoggerInstanceCount
} from '../../utils/logging/Logger.js'
import { OCEAN_NODE_LOGGER } from '../../utils/logging/common.js'
import type { Database } from '../../components/database/index.js'
import winston from 'winston'

function fakeLogDatabase(inserted: any[]): Database {
  return {
    logs: {
      insertLog: (entry: any) => {
        inserted.push(entry)
        return Promise.resolve(entry)
      }
    }
  } as unknown as Database
}

describe('Logger instances and transports tests', () => {
  let envOverrides: OverrideEnvConfig[]

  before(async () => {
    envOverrides = await setupEnvironment(
      null,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.LOG_DB], ['false'])
    )
  })

  it(`should exist only ${MAX_LOGGER_INSTANCES} instances MAX`, () => {
    // the 8 module loggers of common.ts, plus the ones some tests create
    expect(getLoggerInstanceCount()).to.be.at.least(8)
    expect(getLoggerInstanceCount()).to.be.lessThanOrEqual(MAX_LOGGER_INSTANCES)
  })

  it(`should change LOG_DB to "true" and logger should have DB transport`, async () => {
    expect(USE_DB_TRANSPORT()).to.be.equal(false)
    expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(false)
    const envAfter = await setupEnvironment(
      null,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.LOG_DB], ['true'])
    )
    expect(USE_DB_TRANSPORT()).to.be.equal(true)

    const first: any[] = []
    const second: any[] = []
    try {
      // will build the DB transport layer (the other loggers attach it lazily)
      configureCustomDBTransport(fakeLogDatabase(first), OCEAN_NODE_LOGGER)
      OCEAN_NODE_LOGGER.info('Should build DB transport layer')
      expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(true)

      const transports: winston.transport[] = OCEAN_NODE_LOGGER.getTransports().filter(
        (transport: winston.transport) => transport instanceof CustomOceanNodesTransport
      )
      expect(transports.length).to.be.equal(1)
      // log lines reach the transports asynchronously
      await sleep(20)

      // a re-initialized database rebinds the same transport
      configureCustomDBTransport(fakeLogDatabase(second), OCEAN_NODE_LOGGER)
      OCEAN_NODE_LOGGER.warn('Should go to the second database')
      await sleep(20)
      expect(first.some((e) => e.message.includes('Should build DB transport'))).to.equal(
        true
      )
      expect(second.some((e) => e.message.includes('Should go to the second'))).to.equal(
        true
      )
      expect(second.every((e) => e.moduleName && e.level)).to.equal(true)

      OCEAN_NODE_LOGGER.removeTransport(transports[0])
      expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(false)
    } finally {
      await tearDownEnvironment(envAfter)
    }
    expect(USE_DB_TRANSPORT()).to.be.equal(false)
    // with LOG_DB off again the transport is dropped lazily on the next log call
    OCEAN_NODE_LOGGER.debug('LOG_DB is off again')
    expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(false)
  })

  after(async () => {
    // Restore original local setup / env variables after test
    await tearDownEnvironment(envOverrides)
  })
})
