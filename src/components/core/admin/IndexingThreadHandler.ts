import { P2PCommandResponse } from '../../../@types/index.js'
import {
  Command,
  IndexingCommand,
  StartStopIndexingCommand
} from '../../../@types/commands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import {
  buildErrorResponse,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { AdminHandler } from './adminHandler.js'
import { checkSupportedChainId } from '../../../utils/blockchain.js'

export class IndexingThreadHandler extends AdminHandler {
  validate(command: Command): ValidateParams {
    throw new Error('Method not implemented.')
  }

  async validateAdminCommand(command: StartStopIndexingCommand): Promise<ValidateParams> {
    if (
      !validateCommandParameters(command, ['action']) ||
      ![IndexingCommand.START_THREAD, IndexingCommand.STOP_THREAD].includes(
        command.action
      ) ||
      (command.chainId && !checkSupportedChainId(command.chainId))
    ) {
      return buildInvalidRequestMessage(
        `Missing or invalid "action" and/or "chainId" fields for command: "${command}".`
      )
    }
    return await super.validateAdminCommand(command)
  }

  // eslint-disable-next-line require-await
  async handle(task: StartStopIndexingCommand): Promise<P2PCommandResponse> {
    const validation = await this.validateAdminCommand(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    const indexer = this.getOceanNode().getIndexer()
    if (!indexer) {
      return buildErrorResponse('Node is not running an indexer instance!')
    }
    if (task.action === IndexingCommand.START_THREAD) {
      const output = task.chainId
        ? indexer.startThread(task.chainId)
        : indexer.startThreads()
      return {
        status: {
          httpStatus: output ? 200 : 400,
          error: output ? null : 'Unable to start indexing thread(s)!'
        },
        stream: output ? new ReadableString('OK') : null
      }
    } else if (task.action === IndexingCommand.STOP_THREAD) {
      const output = task.chainId
        ? indexer.stopThread(task.chainId)
        : indexer.stopAllThreads()
      return {
        status: {
          httpStatus: output ? 200 : 400,
          error: output ? null : 'Unable to stop indexing thread(s)!'
        },
        stream: output ? new ReadableString('OK') : null
      }
    }
  }
}
