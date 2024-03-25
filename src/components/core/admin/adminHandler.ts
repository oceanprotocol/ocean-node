import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { OceanNode } from '../../../OceanNode.js'
import { AdminCommand, Command } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { validateSignature } from '../../../utils/auth.js'
import { Handler } from '../handler.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export abstract class AdminHandler extends Handler {
  validate(command: AdminCommand): ValidateParams {
    CORE_LOGGER.logMessage(``)
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    CORE_LOGGER.logMessage(`commandValidation: ${JSON.stringify(commandValidation)}`)
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      return buildInvalidRequestMessage('Expired authentication or invalid signature')
    }
  }

  abstract handle(task: Command): Promise<P2PCommandResponse>

  getOceanNode(): OceanNode {
    return super.getOceanNode()
  }
}
