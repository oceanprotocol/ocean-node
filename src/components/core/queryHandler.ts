import { Handler } from './handler.js'
import { QueryCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { TypesenseError } from '../database/typesense.js'

export class QueryHandler extends Handler {
  isQueryCommand(obj: any): obj is QueryCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'query' in obj
  }

  async handle(task: any): Promise<P2PCommandResponse> {
    if (!this.isQueryCommand(task)) {
      throw new Error(`Task has not QueryCommand type. It has ${typeof task}`)
    }
    try {
      let result = await this.getP2PNode().getDatabase().ddo.search(task.query)
      if (!result) {
        result = []
      }
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return {
          stream: null,
          status: { httpStatus: 404, error: `Not found. ${error.message}` }
        }
      }
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
