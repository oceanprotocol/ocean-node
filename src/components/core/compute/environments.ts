import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ComputeEnvByChain } from '../../../@types/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler/handler.js'
import { ComputeGetEnvironmentsCommand } from '../../../@types/commands.js'
import { getConfiguration } from '../../../utils/config.js'
import { C2DEngine } from '../../c2d/compute_engines.js'
import { fetchEnvironments } from '../utils/environments.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
export class ComputeGetEnvironmentsHandler extends Handler {
  validate(command: ComputeGetEnvironmentsCommand): ValidateParams {
    const validateCommand = validateCommandParameters(command, [])
    if (!validateCommand.valid) {
      return buildInvalidRequestMessage(
        'Invalid getComputeEnv command ' + validateCommand.reason
      )
    }
    return validateCommand
  }

  async handle(task: ComputeGetEnvironmentsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const result: ComputeEnvByChain = {}
      const config = await getConfiguration()
      const { c2dClusters } = config

      for (const cluster of c2dClusters) {
        const engine = C2DEngine.getC2DClass(cluster)
        if (task.chainId) {
          result[task.chainId] = await fetchEnvironments(task.chainId, engine)
        } else {
          for (const chain of Object.keys(config.supportedNetworks)) {
            const chainId = parseInt(chain)
            result[chainId] = await fetchEnvironments(chainId, engine)
          }
        }
      }

      CORE_LOGGER.logMessage(
        'ComputeGetEnvironmentsCommand Response: ' + JSON.stringify(result, null, 2),
        true
      )

      return {
        stream: Readable.from(JSON.stringify(result)),
        status: {
          httpStatus: 200
        }
      }
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
