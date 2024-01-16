import { P2PCommandResponse } from '../../@types'
import { FileInfoCommand } from '../../utils'
import { P2P_CONSOLE_LOGGER } from '../../utils/logging/common'
import { Handler } from './handler'

export class DownloadHandler extends Handler {
  // No encryption here yet

  async handle(task: FileInfoCommand): Promise<P2PCommandResponse> {
    try {
      P2P_CONSOLE_LOGGER.logMessage(
        'File Info Request recieved with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      return {
        stream: null,
        status: {
          httpStatus: 200
        }
      }
    } catch (error) {
      P2P_CONSOLE_LOGGER.error(error.message)
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
