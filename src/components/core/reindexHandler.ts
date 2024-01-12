import { Handler } from './handler.js'
import { ReindexCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { OceanIndexer } from '../Indexer/index.js'

export class ReindexHandler extends Handler {
  async handle(task: ReindexCommand): Promise<P2PCommandResponse> {
    try {
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
      await OceanIndexer.addReindexTask({
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
