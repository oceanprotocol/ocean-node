import { FindDDOCommand, GetDdoCommand } from '../../utils/constants'
import { P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import OceanNodeInstance from '../../index.js'

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

export async function findProvidersForDDO(
  task: FindDDOCommand
): Promise<P2PCommandResponse> {
  try {
    const providers = await this.getProvidersForDid(task.id)
    return {
      stream: Readable.from(JSON.stringify(providers)),
      status: { httpStatus: 200 }
    }
  } catch (error) {
    return {
      stream: null,
      status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
    }
  }
}
