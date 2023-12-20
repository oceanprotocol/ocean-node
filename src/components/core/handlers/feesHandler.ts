import { GetFeesCommand } from '../../../utils/constants.js'
import { P2PCommandResponse } from '../../../@types'
import { Readable } from 'stream'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { logger, calculateFee } from './utils/feesHandler.js'

import { Handler } from './aHandler.js'

export class FeesHandler extends Handler {
  public constructor(task: any) {
    super(task, null, null)
    if (!this.isGetFeesCommand(task)) {
      throw new Error(`Task has not GetFeesCommand type. It has ${typeof task}`)
    }
  }

  isGetFeesCommand(obj: any): obj is GetFeesCommand {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'command' in obj &&
      'ddo' in obj &&
      'serviceId' in obj
    )
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      const task = this.getTask() as GetFeesCommand
      logger.logMessage(
        `Try to calculate fees for DDO with id: ${task.ddo.id} and serviceId: ${task.serviceId}`,
        true
      )

      const fees = await calculateFee(task.ddo, task.serviceId)
      if (fees) {
        return {
          stream: Readable.from(JSON.stringify(fees, null, 4)),
          status: { httpStatus: 200 }
        }
      } else {
        const error = `Unable to calculate fees (null) for DDO with id: ${task.ddo.id} and serviceId: ${task.serviceId}`
        logger.logMessageWithEmoji(
          error,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error
          }
        }
      }
    } catch (error) {
      logger.logMessageWithEmoji(
        error.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }
}
