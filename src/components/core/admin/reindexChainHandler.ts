import { AdminHandler } from './adminHandler.js'
import { AdminReindexChainCommand } from '../../../@types/commands.js'
import {
  validateCommandParameters,
  ValidateParams,
  buildInvalidRequestMessage,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { checkSupportedChainId, Blockchain } from '../../../utils/blockchain.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { processBlocks, getDeployedContractBlock } from '../../Indexer/utils.js'

export class ReindexChainHandler extends AdminHandler {
  validate(command: AdminReindexChainCommand): ValidateParams {
    if (!validateCommandParameters(command, ['chainId', 'txId'])) {
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
      CORE_LOGGER.error(`Chain ID ${task.chainId} is not supported in config.`)
      return
    }
    const blockchain = new Blockchain(checkChainId.networkRpc, task.chainId)
    const provider = blockchain.getProvider()
    const signer = blockchain.getSigner()
    const deployedBlock = getDeployedContractBlock(task.chainId)
    try {
      await this.getOceanNode().getDatabase().ddo.deleteAllAssetsFromChain(task.chainId)
      CORE_LOGGER.logMessage(
        `Assets from chain ${task.chainId} were deleted from db, now starting to reindex...`
      )
      const latestBlock = await provider.getBlockNumber()
      const ret = await processBlocks(
        signer,
        provider,
        task.chainId,
        deployedBlock,
        latestBlock - deployedBlock + 1
      )
      if (!ret) {
        CORE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_ERROR,
          `Reindex chain failed on chain ${task.chainId}.`,
          true
        )
        return
      }

      return {
        status: { httpStatus: 200 },
        stream: new ReadableString('REINDEX CHAIN OK')
      }
    } catch (error) {
      CORE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `REINDEX chain: ${error.message} `,
        true
      )
    }
  }
}
