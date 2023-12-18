import { QueryCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { OceanP2P } from '../P2P/index.js'

export async function handleQueryCommand(
  node: OceanP2P,
  task: QueryCommand
): Promise<P2PCommandResponse> {
  try {
    let result = await node.getDatabase().ddo.search(task.query)
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
