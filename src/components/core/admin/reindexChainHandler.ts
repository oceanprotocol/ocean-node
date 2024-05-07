import { AdminHandler } from './adminHandler.js'
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
import { OceanIndexer } from '../../Indexer/index.js'

export class ReindexChainHandler extends AdminHandler {
  validate(command: AdminReindexChainCommand): ValidateParams {
    if (!validateCommandParameters(command, ['chainId'])) {
      return buildInvalidRequestMessage(
        `Missing chainId field for command: "${command}".`
      )
    }
    return super.validate(command)
  }

  async handle(task: AdminReindexChainCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
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
      OceanIndexer.resetCrawling(task.chainId)
      return {
        status: { httpStatus: 200 },
        stream: new ReadableString('REINDEXING CHAIN...')
      }
    } catch (error) {
      CORE_LOGGER.error(`REINDEX chain: ${error.message}`)
      return buildErrorResponse(`REINDEX chain: ${error.message}`)
    }
  }
}
