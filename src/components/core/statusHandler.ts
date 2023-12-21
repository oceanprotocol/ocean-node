import { Handler } from './handler.js'
import { status } from './utils/statusHandler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Command } from '../../utils/constants.js'
import { Readable } from 'stream'

export class StatusHandler extends Handler {
  isCommand(obj: any): obj is Command {
    return typeof obj === 'object' && obj !== null && 'command' in obj
  }

  async handle(task: any): Promise<P2PCommandResponse> {
    if (!this.isCommand(task)) {
      throw new Error(`Task has not Command type. It has ${typeof task}`)
    }
    try {
      const statusResult = await status(this.getP2PNode().getConfig(), task.node)
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
