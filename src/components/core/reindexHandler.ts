import { Handler } from './handler.js'
import { ReindexCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { OceanNodeSingleton } from '../../index.js'

export class ReindexHandler extends Handler {
  isReindexCommand(obj: any): obj is ReindexCommand {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'command' in obj &&
      'txId' in obj &&
      'chainId' in obj
    )
  }

  async handle(task: any): Promise<P2PCommandResponse> {
    try {
      if (!this.isReindexCommand(task)) {
        throw new Error(`Task has not ReindexCommand type. It has ${typeof task}`)
      }
      const txId: string = String(task.txId).toLowerCase()
      if (!/^0x([A-Fa-f0-9]{64})$/.test(txId)) {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid parameter txId' }
        }
      }
      const chainId: string = String(task.chainId)
      if (!chainId) {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid parameter chainId' }
        }
      }
      const eventIndex: number = Number(task.eventIndex)
      await OceanNodeSingleton.getIndexer().addReindexTask({
        txId,
        chainId,
        eventIndex
      })
      return {
        stream: Readable.from(JSON.stringify('Added to reindex queue successfully')),
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
