import { QueryCommand } from '../../../utils/constants.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { Readable } from 'stream'
import { Handler } from '../handler.js'
import { Database } from '../../database/index.js'

export class QueryHandler extends Handler {
  public constructor(task: any, database: Database) {
    super(task, null, database)
    if (!this.isQueryCommand(task)) {
      throw new Error(`Task has not QueryCommand type. It has ${typeof task}`)
    }
  }

  isQueryCommand(obj: any): obj is QueryCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'query' in obj
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      let result = await this.getDatabase().ddo.search(this.getTask().query)
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
