import { CommandHandler } from './handler.js'
import { status } from '../utils/statusHandler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { DetailedStatusCommand, StatusCommand } from '../../../@types/commands.js'
import { Readable } from 'stream'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class StatusHandler extends CommandHandler {
  validate(command: StatusCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: StatusCommand): Promise<P2PCommandResponse> {
    const checks = await this.verifyParamsAndRateLimits(task)
    if (checks.status.httpStatus !== 200 || checks.status.error !== null) {
      return checks
    }
    try {
      const statusResult = await status(this.getOceanNode(), task.node, !!task.detailed)
      if (!statusResult) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Status Not Found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(statusResult, null, 4)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.error(`Error in StatusHandler: ${error.message}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class DetailedStatusHandler extends StatusHandler {
  validate(command: DetailedStatusCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: StatusCommand): Promise<P2PCommandResponse> {
    task.detailed = true
    return await super.handle(task)
  }
}
