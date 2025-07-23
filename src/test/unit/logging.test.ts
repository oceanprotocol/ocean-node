import { Database } from '../../components/database/index.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'

import { expect } from 'chai'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import {
  CustomOceanNodesTransport,
  MAX_LOGGER_INSTANCES,
  NUM_LOGGER_INSTANCES,
  USE_DB_TRANSPORT,
  isDevelopmentEnvironment
} from '../../utils/logging/Logger.js'
import { OCEAN_NODE_LOGGER } from '../../utils/logging/common.js'
import winston from 'winston'

let envOverrides: OverrideEnvConfig[]

describe('Logger instances and transports tests', async () => {
  before(() => {})
  // need to do it first
  envOverrides = await setupEnvironment(
    TEST_ENV_CONFIG_FILE,
    buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.NODE_ENV,
        ENVIRONMENT_VARIABLES.LOG_DB,
        ENVIRONMENT_VARIABLES.LOG_LEVEL
      ],
      ['development', 'false', 'info']
    )
  )
  // because of this
  it('should be development environment', () => {
    expect(isDevelopmentEnvironment()).to.be.equal(true)
  })

  it(`should exist only ${MAX_LOGGER_INSTANCES} instances MAX`, () => {
    const numExistingInstances = NUM_LOGGER_INSTANCES
    expect(numExistingInstances).to.be.lessThanOrEqual(MAX_LOGGER_INSTANCES)
  })

  it(`should change LOG_DB to "true" and logger should have DB transport`, async function () {
    // when we are logging to DB, things can slow down a bit
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    expect(USE_DB_TRANSPORT()).to.be.equal(false)
    expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(false)
    const envAfter = await setupEnvironment(
      null,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.LOG_DB], ['true'])
    )
    expect(USE_DB_TRANSPORT()).to.be.equal(true)
    // will build the DB transport layer
    const config = await getConfiguration(true)
    // eslint-disable-next-line no-unused-vars
    const DB = await new Database(config.dbConfig)
    // Could generate Typesene error if DB is not running, but does not matter for this test
    OCEAN_NODE_LOGGER.logMessage('Should build DB transport layer')

    expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(true)

    const transports: winston.transport[] = OCEAN_NODE_LOGGER.getTransports().filter(
      (transport: winston.transport) => {
        return transport instanceof CustomOceanNodesTransport
      }
    )
    expect(transports.length).to.be.equal(1)
    OCEAN_NODE_LOGGER.removeTransport(transports[0])
    expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(false)
    await tearDownEnvironment(envAfter)
    expect(USE_DB_TRANSPORT()).to.be.equal(false)
  })

  after(async () => {
    // Restore original local setup / env variables after test
    await tearDownEnvironment(envOverrides)
  })
})
