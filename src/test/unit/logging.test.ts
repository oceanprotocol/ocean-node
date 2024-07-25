import { ENVIRONMENT_VARIABLES } from '../../utils/index.js'

import { expect } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import {
  MAX_LOGGER_INSTANCES,
  NUM_LOGGER_INSTANCES,
  isDevelopmentEnvironment
} from '../../utils/logging/Logger.js'

let envOverrides: OverrideEnvConfig[]

describe('Logger instances and transports tests', async () => {
  before(() => {})
  // need to do it first
  envOverrides = await setupEnvironment(
    null,
    buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.NODE_ENV,
        ENVIRONMENT_VARIABLES.LOG_DB,
        ENVIRONMENT_VARIABLES.LOG_LEVEL,
        ENVIRONMENT_VARIABLES.DB_URL
      ],
      ['development', 'false', 'info', 'http://localhost:8108/?apiKey=xyz']
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

  after(() => {
    // Restore original local setup / env variables after test
    tearDownEnvironment(envOverrides)
  })
})
