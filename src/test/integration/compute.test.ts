import { expect, assert } from 'chai'
import { GetEnvironmentsHandler } from '../../components/core/compute.js'
import { getConfiguration } from '../../utils/config.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

describe('Compute', () => {
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode

  before(async () => {
    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)

    // Ensure that c2dClusters is loaded
    if (!config.c2dClusters || config.c2dClusters.length === 0) {
      throw new Error('Failed to load c2dClusters configuration')
    }
  })

  it('Sets up compute envs', async () => {
    assert(oceanNode, 'Failed to instantiate OceanNode')
    assert(config.c2dClusters, 'Failed to get c2dClusters')
  })

  it('Get compute environments', async () => {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.GET_COMPUTE_ENVIRONMENTS,
      chainId: 8996
    }
    const response = await new GetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    console.log('Response: ', response)
  })
})
