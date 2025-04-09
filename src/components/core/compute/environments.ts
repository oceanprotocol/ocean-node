import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { CommandHandler } from '../handler/handler.js'
import { ComputeGetEnvironmentsCommand } from '../../../@types/commands.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
export class ComputeGetEnvironmentsHandler extends CommandHandler {
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
      const computeEngines = this.getOceanNode().getC2DEngines()
      const result = await computeEngines.fetchEnvironments(task.chainId)

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
