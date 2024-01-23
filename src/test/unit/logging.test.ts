import { Database } from '../../components/database/index.js'
import { ENVIRONMENT_VARIABLES, getEnvConfig } from '../../utils/index.js'

import { expect } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import {
  CustomOceanNodesTransport,
  MAX_LOGGER_INSTANCES,
  NUM_LOGGER_INSTANCES,
  isDevelopmentEnvironment
} from '../../utils/logging/Logger.js'
import { OCEAN_NODE_LOGGER } from '../../utils/logging/common.js'
import winston from 'winston'

let envOverrides: OverrideEnvConfig[]

describe('Logger instances and transports tests', async () => {
  before(() => {})
  // need to do it first
  envOverrides = await setupEnvironment(
    null,
    buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.NODE_ENV], ['development'])
  )
  // because of this
  it('should be development environment', () => {
    expect(isDevelopmentEnvironment()).to.be.equal(true)
  })

  it(`should exist only ${MAX_LOGGER_INSTANCES} instances MAX`, () => {
    const numExistingInstances = NUM_LOGGER_INSTANCES
    expect(numExistingInstances).to.be.lessThanOrEqual(MAX_LOGGER_INSTANCES)
  })

  it(`should change NODE_ENV to "production" and logger should have DB transport`, async () => {
    expect(process.env.NODE_ENV).to.be.equal('development')
    expect(OCEAN_NODE_LOGGER.hasDBTransport()).to.be.equal(false)
    const envAfter = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [ENVIRONMENT_VARIABLES.NODE_ENV, ENVIRONMENT_VARIABLES.DB_URL],
        ['production', 'http://172.15.0.6:8108?apiKey=xyz']
      )
    )
    expect(process.env.NODE_ENV).to.be.equal('production')
    // will build the DB transport layer
    const config = await getEnvConfig()
    const DB = new Database(config.dbConfig)
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
    expect(process.env.NODE_ENV).to.be.equal('development')
  })

  after(() => {
    // Restore original local setup / env variables after test
    tearDownEnvironment(envOverrides)
  })
})
