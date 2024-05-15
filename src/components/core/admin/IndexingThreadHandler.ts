import { P2PCommandResponse } from '../../../@types/index.js'
import { IndexingCommand, StartStopIndexingCommand } from '../../../@types/commands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import {
  buildInvalidParametersResponse,
  buildInvalidRequestMessage,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { AdminHandler } from './adminHandler.js'

export class IndexingThreadHandler extends AdminHandler {
  validate(command: StartStopIndexingCommand): ValidateParams {
    if (
      !validateCommandParameters(command, ['chainId']) ||
      ![IndexingCommand.START_THREAD, IndexingCommand.STOP_THREAD].includes(
        command.action
      )
    ) {
      return buildInvalidRequestMessage(
        `Missing "chainId" field or invalid "action" for command: "${command}".`
      )
    }
    return super.validate(command)
  }

  // eslint-disable-next-line require-await
  async handle(task: StartStopIndexingCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    const indexer = this.getOceanNode().getIndexer()
    if (!indexer) {
      return {
        status: {
          httpStatus: 400,
          error: 'Node is not running an indexer instance!'
        },
        stream: null
      }
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
    return {
      status: {
        httpStatus: 200,
        error: null
      },
      stream: new ReadableString('OK')
    }
  }
}
