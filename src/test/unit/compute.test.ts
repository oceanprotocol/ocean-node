import { checkC2DEnvExists } from '../../components/c2d/index.js'
import { expect } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { RPCS } from '../../@types/blockchain.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { getConfiguration } from '../../utils/config.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

describe('C2D related functions', () => {
  let config: OceanNodeConfig
  let database: Database
  let oceanNode: OceanNode

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  let previousConfiguration: OverrideEnvConfig[]

  before(async () => {
    // override and save configuration (always before calling getConfig())
    previousConfiguration = await setupEnvironment(
      null,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.DB_URL
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          'http://localhost:8108/?apiKey=xyz'
        ]
      )
    )

    config = await getConfiguration(true)
    database = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(database)
  })

  it('should checkC2DEnvExists', async () => {
    const envId = '0x123'
    const result = await checkC2DEnvExists(envId, oceanNode)
    expect(result).to.equal(false)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })
})
