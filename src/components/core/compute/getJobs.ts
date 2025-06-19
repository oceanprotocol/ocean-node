import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { GetJobsCommand } from '../../../@types/commands.js'
import { CommandHandler } from '../handler/handler.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { buildInvalidRequestMessage } from '../../httpRoutes/validateCommands.js'

export class GetJobsHandler extends CommandHandler {
  validate(command: GetJobsCommand) {
    if (command.fromTimestamp && typeof command.fromTimestamp !== 'string') {
      return buildInvalidRequestMessage(
        'Invalid fromTimestamp parameter, must be a string'
      )
    }
    return { valid: true }
  }

  async handle(task: GetJobsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      const { c2d } = this.getOceanNode().getDatabase()
      if (!c2d) {
        throw new Error('Database not initialized')
      }

      const jobs = await c2d.getAllJobs(task.fromTimestamp)

      return {
        status: {
          httpStatus: 200,
          error: null
        },
        stream: Readable.from(JSON.stringify(jobs))
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      CORE_LOGGER.error('Error getting jobs: ' + errMsg)

      return {
        status: {
          httpStatus: 500,
          error: 'Failed to retrieve jobs: ' + errMsg
        },
        stream: Readable.from('[]')
      }
    }
  }
}
