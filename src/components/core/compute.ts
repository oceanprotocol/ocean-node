import { Readable } from 'stream'
import { P2PCommandResponse } from '../../@types'
import { CORE_LOGGER } from '../../utils/logging/common'
import { Handler } from './handler'
import { GetEnvironments } from '../../utils/constants.js'

export class GetEnvironmentsHandler extends Handler {
  async handle(task: GetEnvironments): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'File Info Request recieved with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      const oceanNode = await this.getOceanNode()
      const response: any[] = []

      CORE_LOGGER.logMessage(
        'File Info Response: ' + JSON.stringify(response, null, 2),
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
