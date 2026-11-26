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

// ESCROW_EMPTY_TX is a safety-relevant toggle: when off (the default) the node skips zero-value
// escrow txs and records the 0xempty sentinel. These tests pin the env→config parsing so a typo or
// a schema change cannot silently flip the default and start/stop sending on-chain zero txs.
describe('ESCROW_EMPTY_TX configuration', () => {
  let envOverrides: OverrideEnvConfig[]

  afterEach(async () => {
    if (envOverrides) {
      await tearDownEnvironment(envOverrides)
      envOverrides = undefined
    }
  })

  it('defaults to false when unset', async () => {
    // set an unrelated var so the base test environment is applied without ESCROW_EMPTY_TX
    envOverrides = buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.ESCROW_EMPTY_TX], [''])
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    delete process.env.ESCROW_EMPTY_TX
    const config = await getConfiguration(true)
    expect(config.escrowEmptyTx).to.equal(false)
  })

  it('parses "true" as true', async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.ESCROW_EMPTY_TX],
      ['true']
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    const config = await getConfiguration(true)
    expect(config.escrowEmptyTx).to.equal(true)
  })

  it('parses "false" as false', async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.ESCROW_EMPTY_TX],
      ['false']
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
    const config = await getConfiguration(true)
    expect(config.escrowEmptyTx).to.equal(false)
  })
})
