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

export abstract class AdminHandler extends Handler {
  validate(command: AdminCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      return buildInvalidRequestMessage('Expired authentication or invalid signature')
    }
    return {
      valid: true
    }
  }

  abstract handle(task: Command): Promise<P2PCommandResponse>

  getOceanNode(): OceanNode {
    return super.getOceanNode()
  }
}
