import { P2PCommandResponse } from '../../../@types/index.js'
import { IndexingCommand, StartStopIndexingCommand } from '../../../@types/commands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import {
  buildErrorResponse,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { AdminCommandHandler } from './adminHandler.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export class IndexingThreadHandler extends AdminCommandHandler {
  async validateAdminCommand(command: StartStopIndexingCommand): Promise<ValidateParams> {
    if (
      !validateCommandParameters(command, ['action']) ||
      ![IndexingCommand.START_THREAD, IndexingCommand.STOP_THREAD].includes(
        command.action
      ) ||
      (command.chainId && !this.getOceanNode().checkSupportedChainId(command.chainId))
    ) {
      return buildInvalidRequestMessage(
        `Missing or invalid "action" and/or "chainId" fields for command: "${command}".`
      )
    }
    return await super.validate(command)
  }

  async handle(task: StartStopIndexingCommand): Promise<P2PCommandResponse> {
    const validation = await this.validateAdminCommand(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    const indexer = this.getOceanNode().getIndexer()
    if (!indexer) {
      return buildErrorResponse('Node is not running an indexer instance!')
    }
    CORE_LOGGER.info(`Admin ${task.action} for chain ${task.chainId ?? 'all'}`)
    if (task.action === IndexingCommand.START_THREAD) {
      // Await the start: these are async operations (they can sleep for seconds while the chain
      // connection comes up). Without the await `output` was always a truthy Promise, so the
      // handler reported HTTP 200 before the indexer had actually started (or failed). A per-chain
      // start resolves to the ChainIndexer or null; a start-all resolves to a boolean.
      const success = task.chainId
        ? (await indexer.startChainIndexer(task.chainId)) !== null
        : (await indexer.startAllChainIndexers()) === true
      return {
        status: {
          httpStatus: success ? 200 : 400,
          error: success ? null : 'Unable to start indexing thread(s)!'
        },
        stream: success ? new ReadableString('OK') : null
      }
    } else if (task.action === IndexingCommand.STOP_THREAD) {
      // Await the stop for the same reason. stopChainIndexer resolves to void (success unless it
      // throws); stopAllChainIndexers resolves to a boolean.
      let success = true
      try {
        if (task.chainId) {
          await indexer.stopChainIndexer(task.chainId)
        } else {
          success = (await indexer.stopAllChainIndexers()) === true
        }
      } catch (error) {
        CORE_LOGGER.error(`Unable to stop indexing thread(s): ${error?.message ?? error}`)
        success = false
      }
      return {
        status: {
          httpStatus: success ? 200 : 400,
          error: success ? null : 'Unable to stop indexing thread(s)!'
        },
        stream: success ? new ReadableString('OK') : null
      }
    }
  }
}
