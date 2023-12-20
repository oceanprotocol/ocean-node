import { Handler } from '../handler.js'
import { GetDdoCommand } from '../../../utils/constants.js'
import { Database } from '../../database/index.js'
import { P2PCommandResponse } from '../../../@types/index.js'
import { Readable } from 'stream'

export class GetDdoHandler extends Handler {
  public constructor(task: any, database: Database) {
    super(task, null, database)
    if (!this.isGetDdoCommand(task)) {
      throw new Error(`Task has not QueryCommand type. It has ${typeof task}`)
    }
  }

  isGetDdoCommand(obj: any): obj is GetDdoCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'id' in obj
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      const ddo = await this.getDatabase().ddo.retrieve(this.getTask().id)
      if (!ddo) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Not found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(ddo)),
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
