import { Handler } from './handler.js'
import { status } from './utils/statusHandler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { StatusCommand } from '../../utils/constants.js'
import { Readable } from 'stream'

export class StatusHandler extends Handler {
  async handle(task: StatusCommand): Promise<P2PCommandResponse> {
    try {
      const statusResult = await status(this.getP2PNode(), task.node)
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
