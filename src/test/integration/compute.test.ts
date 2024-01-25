import { expect, assert } from 'chai'
import { GetEnvironmentsHandler } from '../../components/core/compute.js'
import { getConfiguration } from '../../utils/config.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'

describe('Compute', () => {
  it('Get compute environments', async () => {
    const config = await getConfiguration(true)
    const dbconn = await new Database(config.dbConfig)
    const oceanNode = OceanNode.getInstance(dbconn)
    assert(oceanNode, 'Failed to instantiate OceanNode')

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
