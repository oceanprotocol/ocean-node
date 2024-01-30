import { Handler } from './handler.js'
import { QueryCommand } from '../../@types/commands.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'

export class QueryHandler extends Handler {
  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    try {
      let result = await this.getOceanNode().getDatabase().ddo.search(task.query)
      if (!result) {
        result = []
      }
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
