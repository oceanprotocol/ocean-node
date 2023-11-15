import { GetDdoCommand } from '../../utils/constants'
import { P2PCommandResponse } from '../../@types'
import {Readable} from "stream";

export async function handleGetDdoCommand(
  task: GetDdoCommand
): Promise<P2PCommandResponse> {
  try {
    const ddo = await this.db.ddo.retrieve(task.id)
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
