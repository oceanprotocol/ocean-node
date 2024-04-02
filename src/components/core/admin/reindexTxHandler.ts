import { AdminHandler } from './adminHandler.js'
import {
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildInvalidParametersResponse,
  buildErrorResponse,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { AdminReindexTxCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { checkSupportedChainId } from '../../../utils/blockchain.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { OceanIndexer } from '../../Indexer/index.js'
import { ReindexTask } from '../../Indexer/crawlerThread.js'

export class ReindexTxHandler extends AdminHandler {
  validate(command: AdminReindexTxCommand): ValidateParams {
    if (!validateCommandParameters(command, ['chainId', 'txId'])) {
      return buildInvalidRequestMessage(
        `Missing chainId or txId fields for command: "${command}".`
      )
    }
    return super.validate(command)
  }

  async handle(task: AdminReindexTxCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    CORE_LOGGER.logMessage(`Reindexing tx...`)
    const checkChainId = await checkSupportedChainId(task.chainId)
    if (!checkChainId.validation) {
      return buildErrorResponse(
        `Chain ID ${task.chainId} is not supported in the node's config`
      )
    }
    try {
      const reindexTask: ReindexTask = {
        txId: task.txId,
        chainId: task.chainId.toString()
      }

      OceanIndexer.addReindexTask(reindexTask)

      return {
        status: { httpStatus: 200 },
        stream: new ReadableString('REINDEX TX OK')
      }
    } catch (error) {
      CORE_LOGGER.error(`REINDEX tx: ${error.message}`)
      return buildErrorResponse(`REINDEX tx: ${error.message} `)
    }
  }
}
