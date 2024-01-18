import { expect } from 'chai'
import {
  ENVIRONMENT_VARIABLES,
  SUPPORTED_PROTOCOL_COMMANDS,
  getConfig
} from '../../utils/index.js'
import {
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { CoreHandlersRegistry } from '../../components/core/coreHandlersRegistry.js'
import { Handler } from '../../components/core/handler.js'

describe('Commands and handlers', async () => {
  const envOverrides = buildEnvOverrideConfig(
    [ENVIRONMENT_VARIABLES.PRIVATE_KEY],
    ['0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58']
  )
  before(() => {
    setupEnvironment(null, envOverrides)
  })

  it('Check that all supported commands have registered handlers', async () => {
    // To make sure we do not forget to register handlers
    const config: OceanNodeConfig = await getConfig()
    const nodeP2P = new OceanP2P(config)
    for (const command of SUPPORTED_PROTOCOL_COMMANDS) {
      expect(
        CoreHandlersRegistry.getInstance(nodeP2P).getHandler(command)
      ).to.be.instanceof(Handler)
    }
  })

  after(() => {
    tearDownEnvironment(envOverrides)
  })
})
