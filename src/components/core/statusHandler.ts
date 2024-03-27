import { Handler } from './handler.js'
import { status } from './utils/statusHandler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { StatusCommand } from '../../@types/commands.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildRateLimitReachedResponse,
  validateCommandParameters
} from '../httpRoutes/validateCommands.js'

export class StatusHandler extends Handler {
  validate(command: StatusCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: StatusCommand): Promise<P2PCommandResponse> {
    const isOK = await this.checkRateLimit()
    if (!isOK) {
      return buildRateLimitReachedResponse()
    }
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      const statusResult = await status(this.getOceanNode(), task.node)
      if (!statusResult) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Status Not Found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(statusResult)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
