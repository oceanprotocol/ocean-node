import { AdminCommandHandler } from './adminHandler.js'
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
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { checkSupportedChainId } from '../../../utils/blockchain.js'

export class ReindexTxHandler extends AdminCommandHandler {
  async validate(command: AdminReindexTxCommand): Promise<ValidateParams> {
    if (!validateCommandParameters(command, ['chainId', 'txId'])) {
      return buildInvalidRequestMessage(
        `Missing chainId or txId fields for command: "${command}".`
      )
    }
    if (!/^0x([A-Fa-f0-9]{64})$/.test(command.txId)) {
      return buildInvalidRequestMessage(`Invalid format for transaction ID.`)
    }
    return await super.validate(command)
  }

  async handle(task: AdminReindexTxCommand): Promise<P2PCommandResponse> {
    const validation = await this.validate(task)
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
      const indexer = this.getOceanNode().getIndexer()
      if (!indexer) {
        return buildErrorResponse('Node is not running an indexer instance!')
      }
      const job = indexer.addReindexTask({
        txId: task.txId,
        chainId: task.chainId
      })

      if (job) {
        return {
          status: { httpStatus: 200 },
          stream: new ReadableString(JSON.stringify(job))
        }
      }
      return buildErrorResponse(
        `Unable to reindex tx ${task.txId}, worker thread is not valid/running?`
      )
    } catch (error) {
      CORE_LOGGER.error(`REINDEX tx: ${error.message}`)
      return buildErrorResponse(`REINDEX tx: ${error.message} `)
    }
  }
}
