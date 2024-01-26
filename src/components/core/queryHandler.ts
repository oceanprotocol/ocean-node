import { Handler } from './handler.js'
import { QueryCommand } from '../../utils/index.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { DDO } from '../../@types/DDO/DDO.js'

export class QueryHandler extends Handler {
  async handle(task: QueryCommand): Promise<P2PCommandResponse> {
    try {
      let result = await this.getOceanNode().getDatabase().ddo.search(task.query)
      if (!result) {
        result = []
      }
      let aggregatedResults: any = []

      if (aggregatedResults.length === 0) {
        aggregatedResults = []
      }

      return {
        stream: Readable.from(JSON.stringify(aggregatedResults)),
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
