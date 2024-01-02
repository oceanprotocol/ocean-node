import { Handler } from './handler.js'
import { ReindexCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'

export class ReindexHandler extends Handler {
  isReindexCommand(obj: any): obj is ReindexCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'txId' in obj && 'chainId' in obj
  }

  async handle(task: any): Promise<P2PCommandResponse> {
    try {
      if (!this.isReindexCommand(task)) {
        throw new Error(`Task has not ReindexCommand type. It has ${typeof task}`)
      }
      // let result = await this.getP2PNode().getDatabase().ddo.search(task.query)
      // if (!result) {
      //   result = []
      // }
      const result = ['ReindexCommand']
      return {
        stream: Readable.from(JSON.stringify(result)),
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
