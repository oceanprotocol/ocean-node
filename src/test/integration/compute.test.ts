import { expect, assert } from 'chai'
import { GetEnvironmentsHandler } from '../../components/core/compute.js'
import { getConfiguration } from '../../utils/config.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { streamToObject } from '../../utils/util.js'
import { isRunningContinousIntegrationEnv } from '../utils/utils.js'

describe('Compute', () => {
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode

  before(async () => {
    config = await getConfiguration(true) // Force reload the configuration
    dbconn = await new Database(config.dbConfig)
    oceanNode = await OceanNode.getInstance(dbconn)
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

    assert(response, 'Failed to get response')
    if (!isRunningContinousIntegrationEnv()) {
      // This fails locally because of invalid URL
      return
    }
    assert(response.status.httpStatus === 200, 'Failed to get 200 response')
    assert(response.stream, 'Failed to get stream')
    expect(response.stream).to.be.instanceOf(Readable)

    const computeEnvironments = await streamToObject(response.stream as Readable)

    for (const computeEnvironment of computeEnvironments) {
      assert(computeEnvironment.id, 'id missing in computeEnvironments')
      assert(
        computeEnvironment.consumerAddress,
        'consumerAddress missing in computeEnvironments'
      )
      assert(computeEnvironment.lastSeen, 'lastSeen missing in computeEnvironments')
      assert(computeEnvironment.id.startsWith('0x'), 'id should start with 0x')
      assert(computeEnvironment.cpuNumber > 0, 'cpuNumber missing in computeEnvironments')
      assert(computeEnvironment.ramGB > 0, 'ramGB missing in computeEnvironments')
      assert(computeEnvironment.diskGB > 0, 'diskGB missing in computeEnvironments')
      assert(computeEnvironment.maxJobs > 0, 'maxJobs missing in computeEnvironments')
      assert(
        computeEnvironment.maxJobDuration > 0,
        'maxJobDuration missing in computeEnvironments'
      )
    }
  })
})
