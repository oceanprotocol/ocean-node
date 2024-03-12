import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { StopNodeCommand } from '../../@types/commands.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ReadableString } from '../P2P/handleProtocolCommands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildInvalidParametersResponse
} from '../httpRoutes/validateCommands.js'
import { validateSignature } from '../../utils/auth.js'

export class StopNodeHandler extends Handler {
  validate(command: StopNodeCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      const errorMsg = `Command validation failed: ${JSON.stringify(commandValidation)}`
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
    }
    if (
      !validateSignature(command.expiryTimestamp, command.signature, this.getOceanNode())
    ) {
      const errorMsg = 'Expired authentication or invalid signature'
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
    }
    return commandValidation
  }

  handle(task: StopNodeCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return new Promise<P2PCommandResponse>((resolve, reject) => {
        resolve(buildInvalidParametersResponse(validation))
      })
    }
    CORE_LOGGER.logMessage(`Stopping node execution...`)
    setTimeout(() => {
      process.exit()
    }, 2000)
    return new Promise<P2PCommandResponse>((resolve, reject) => {
      resolve({
        status: { httpStatus: 200 },
        stream: new ReadableString('EXIT OK')
      })
    })
  }
}
