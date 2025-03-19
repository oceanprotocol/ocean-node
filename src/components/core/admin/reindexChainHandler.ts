import { AdminCommandHandler } from './adminHandler.js'
import { AdminReindexChainCommand } from '../../../@types/commands.js'
import {
  validateCommandParameters,
  ValidateParams,
  buildInvalidRequestMessage,
  buildInvalidParametersResponse,
  buildErrorResponse
} from '../../httpRoutes/validateCommands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { checkSupportedChainId } from '../../../utils/blockchain.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'

export class ReindexChainHandler extends AdminCommandHandler {
  async validateAdminCommand(command: AdminReindexChainCommand): Promise<ValidateParams> {
    if (!validateCommandParameters(command, ['chainId'])) {
      return buildInvalidRequestMessage(
        `Missing chainId field for command: "${command}".`
      )
    }
    return await super.validate(command)
  }

  async handle(task: AdminReindexChainCommand): Promise<P2PCommandResponse> {
    const validation = await this.validateAdminCommand(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    CORE_LOGGER.logMessage(`Reindexing chain command called`)
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

      const job = await indexer.resetCrawling(Number(task.chainId), task.block)
      if (job) {
        return {
          status: { httpStatus: 200 },
          stream: new ReadableString(JSON.stringify(job))
        }
      }
      return buildErrorResponse(
        `Unable to reset crawling, worker thread is not valid/running?`
      )
    } catch (error) {
      CORE_LOGGER.error(`REINDEX chain: ${error.message}`)
      return buildErrorResponse(`REINDEX chain: ${error.message}`)
    }
  }
}
