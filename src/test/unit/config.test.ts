import { expect } from 'chai'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { getConfiguration } from '../../utils/config.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_PATH,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

let envOverrides: OverrideEnvConfig[]
let config: OceanNodeConfig
describe('Should validate configuration from JSON', () => {
  before(async () => {
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_PATH, envOverrides)
  })

  it('should get indexer networks from config', async () => {
    config = await getConfiguration(true)
    console.log(`config: ${JSON.stringify(config)}`)
    expect(config.indexingNetworks.length).to.be.equal(1)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
