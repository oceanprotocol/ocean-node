import { Readable } from 'stream'
import { AdminCommandHandler } from './adminHandler.js'
import { AdminStopJobCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class StopJobHandler extends AdminCommandHandler {
  async validate(command: AdminStopJobCommand): Promise<ValidateParams> {
    const validation = validateCommandParameters(command, ['jobId'])
    if (!validation.valid) {
      return buildInvalidRequestMessage(validation.reason)
    }
    return await super.validate(command)
  }

  async handle(task: AdminStopJobCommand): Promise<P2PCommandResponse> {
    const validation = await this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }

    try {
      const index = task.jobId.indexOf('-')
      if (index === -1) {
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: 'Invalid jobId format: expected "<hash>-<jobId>"'
          }
        }
      }
      const hash = task.jobId.slice(0, index)
      const jobId = task.jobId.slice(index + 1)

      const engines = this.getOceanNode().getC2DEngines()
      if (!engines) {
        return {
          stream: null,
          status: { httpStatus: 500, error: 'No C2D engines configured on this node' }
        }
      }

      let engine
      try {
        engine = await engines.getC2DByHash(hash)
      } catch (e) {
        return {
          stream: null,
          status: { httpStatus: 500, error: 'Invalid C2D Environment' }
        }
      }

      // Empty owner bypasses the DB owner filter — admin can stop any job regardless of owner
      const response = await engine.stopComputeJob(jobId, '')
      CORE_LOGGER.logMessage(`Admin stopJob response: ${JSON.stringify(response)}`, true)

      return {
        stream: Readable.from(JSON.stringify(response)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(error.message)
      return {
        stream: null,
        status: { httpStatus: 500, error: error.message }
      }
    }
  }
}
