import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ComputeEnvironment } from '../../../@types/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler/handler.js'
import { ComputeGetEnvironmentsCommand } from '../../../@types/commands.js'
import { getConfiguration } from '../../../utils/config.js'
import { C2DEngine } from '../../c2d/compute_engines.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
export class ComputeGetEnvironmentsHandler extends Handler {
  validate(command: ComputeGetEnvironmentsCommand): ValidateParams {
    const validateCommand = validateCommandParameters(command, ['chainId'])
    if (validateCommand.valid) {
      if (isNaN(command.chainId) || command.chainId < 1) {
        CORE_LOGGER.logMessage(
          `Invalid chainId: ${command.chainId} on GET computeEnvironments request`,
          true
        )
        return buildInvalidRequestMessage('Invalid chainId')
      }
    }
    return validateCommand
  }

  async handle(task: ComputeGetEnvironmentsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const response: ComputeEnvironment[] = []
      const config = await getConfiguration()
      const { c2dClusters } = config

      for (const cluster of c2dClusters) {
        const engine = C2DEngine.getC2DClass(cluster)
        const environments = await engine.getComputeEnvironments(task.chainId)
        response.push(...environments)
      }

      CORE_LOGGER.logMessage(
        'ComputeGetEnvironmentsCommand Response: ' + JSON.stringify(response, null, 2),
        true
      )

      return {
        stream: Readable.from(JSON.stringify(response)),
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
