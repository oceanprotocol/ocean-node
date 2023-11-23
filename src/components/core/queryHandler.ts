import { QueryCommand } from '../../utils/constants'
import { P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'

export async function handleQueryCommand(
  task: QueryCommand
): Promise<P2PCommandResponse> {
  try {
    const result = await this.db.ddo.search(task.query)
    if (!result) {
      return {
        stream: null,
        status: { httpStatus: 400, error: 'Invalid query parameters' }
      }
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
