import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { OceanNode } from '../../../OceanNode.js'
import { AdminCommand, Command, ICommandHandler } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { validateSignature } from '../../../utils/auth.js'

export abstract class AdminHandler implements ICommandHandler {
  private nodeInstance?: OceanNode
  public constructor(oceanNode?: OceanNode) {
    this.nodeInstance = oceanNode
  }

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
  }

  abstract handle(task: Command): Promise<P2PCommandResponse>

  getOceanNode(): OceanNode {
    return this.nodeInstance
  }
}
