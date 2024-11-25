import { OceanNode } from '../../OceanNode.js'
import { getConfiguration } from '../../utils/config.js'
import { ComputeGetEnvironmentsHandler } from '../core/compute/index.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToObject } from '../../utils/util.js'
import { Readable } from 'stream'

export { C2DEngine } from './compute_engine_base.js'

export async function checkC2DEnvExists(
  envId: string,
  oceanNode: OceanNode
): Promise<boolean> {
  const config = await getConfiguration()
  const { supportedNetworks } = config
  for (const supportedNetwork of Object.keys(supportedNetworks)) {
    const getEnvironmentsTask = {
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      chainId: parseInt(supportedNetwork)
    }
    const response = await new ComputeGetEnvironmentsHandler(oceanNode).handle(
      getEnvironmentsTask
    )
    if (response.status.httpStatus === 200) {
      const computeEnvironments = await streamToObject(response.stream as Readable)
      for (const computeEnvironment of computeEnvironments[parseInt(supportedNetwork)]) {
        if (computeEnvironment.id === envId) {
          return true
        }
      }
    }
  }
  return false
}
