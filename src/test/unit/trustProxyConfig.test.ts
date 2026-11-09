import { expect } from 'chai'
import { getConfiguration } from '../../utils/config.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_PATH,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

describe('TRUST_PROXY configuration', () => {
  let envOverrides: OverrideEnvConfig[]

  afterEach(async () => {
    if (envOverrides) {
      await tearDownEnvironment(envOverrides)
      envOverrides = undefined
    }
  })

  it('parses a numeric hop count', async () => {
    envOverrides = buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.TRUST_PROXY], ['1'])
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    const config = await getConfiguration(true)
    expect(config.trustProxy).to.equal(1)
  })

  it('parses a preset / CIDR string', async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.TRUST_PROXY],
      ['loopback']
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    const config = await getConfiguration(true)
    expect(config.trustProxy).to.equal('loopback')
  })

  it('rejects a fractional hop count', async () => {
    envOverrides = buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.TRUST_PROXY], ['1.5'])
    let threw = false
    try {
      await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    } catch {
      threw = true
    }
    expect(threw).to.equal(true)
  })

  it('rejects a negative hop count', async () => {
    envOverrides = buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.TRUST_PROXY], ['-1'])
    let threw = false
    try {
      await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    } catch {
      threw = true
    }
    expect(threw).to.equal(true)
  })

  it('rejects TRUST_PROXY=true (would re-open the X-Forwarded-For spoof)', async () => {
    // setupEnvironment sets the env var (capturing the original for teardown) and then calls
    // getConfiguration internally, so the config-validation rejection surfaces from here.
    envOverrides = buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.TRUST_PROXY], ['true'])
    let threw = false
    try {
      await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    } catch {
      threw = true
    }
    expect(threw).to.equal(true)
  })
})
