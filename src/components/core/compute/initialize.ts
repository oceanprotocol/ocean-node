import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler.js'

import { ComputeInitializeCommand } from '../../../@types/commands.js'
import { C2DEngine } from '../../c2d/compute_engines.js'
import { validateProviderFeesForDatasets } from '../utils/initializeCompute.js'

export class ComputeInitializeHandler extends Handler {
  validateTimestamp(value: number) {
    // in miliseconds
    const timestampNow = new Date().getTime() / 1000
    const validUntil = new Date(value).getTime() / 1000

    return validUntil > timestampNow
  }

  async handle(task: ComputeInitializeCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'Initialize Compute Request recieved with arguments: ' +
          JSON.stringify(task, null, 2),
        true
      )
      if (!task.compute || !task.compute.env) {
        CORE_LOGGER.logMessage(`Invalid compute environment: ${task.compute.env}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Invalid compute environment: ${task.compute.env}`
          }
        }
      }
      const index = task.compute.env.indexOf('-')
      const hash = task.compute.env.slice(0, index)
      const envId = task.compute.env.slice(index + 1)

      // env might contain
      let engine
      try {
        engine = await C2DEngine.getC2DByHash(hash)
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: `Invalid compute environment: ${task.compute.env}`
          }
        }
      }
      if (!engine.envExists(task.chainId, envId)) {
        CORE_LOGGER.logMessage(`Invalid compute environment: ${task.compute.env}`, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: `Invalid compute environment: ${task.compute.env}`
          }
        }
      }
      const { validUntil } = task.compute
      if (!this.validateTimestamp(validUntil)) {
        const errorMsg = `Error validating validUntil ${validUntil}. It is not in the future.`
        CORE_LOGGER.error(errorMsg)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: errorMsg
          }
        }
      }

      return await validateProviderFeesForDatasets(
        this.getOceanNode(),
        task.datasets,
        task.algorithm,
        task.chainId,
        task.compute.env,
        task.compute.validUntil,
        task.consumerAddress
      )
    } catch (error) {
      CORE_LOGGER.error(error.message)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: error.message
        }
      }
    }
  }
}
