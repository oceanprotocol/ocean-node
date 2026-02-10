import { AdminCommandHandler } from './adminHandler.js'
import { AdminGetLogsCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'

export class GetLogsHandler extends AdminCommandHandler {
  async validate(command: AdminGetLogsCommand): Promise<ValidateParams> {
    return await super.validate(command)
  }

  async handle(task: AdminGetLogsCommand): Promise<P2PCommandResponse> {
    const validation = await this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }

    try {
      const startTime = task.startTime
        ? new Date(task.startTime)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Default to 7 days ago
      const endTime = task.endTime ? new Date(task.endTime) : new Date() // Default to now
      const maxLogs = task.maxLogs ?? 100
      const { moduleName, level } = task

      const logs = await this.getOceanNode()
        .getDatabase()
        .logs.retrieveMultipleLogs(startTime, endTime, maxLogs, moduleName, level)

      return {
        status: { httpStatus: 200 },
        stream: new ReadableString(JSON.stringify(logs))
      }
    } catch (error) {
      return {
        status: { httpStatus: 500, error: `Error retrieving logs: ${error.message}` },
        stream: null
      }
    }
  }
}
