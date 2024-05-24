import { AdminCommand } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { validateAdminSignature } from '../../../utils/auth.js'
import { Handler } from '../handler/handler.js'

export abstract class AdminHandler extends Handler {
  validate(command: AdminCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    const signatureValidation = validateAdminSignature(
      command.expiryTimestamp,
      command.signature
    )
    if (!signatureValidation.valid) {
      return buildInvalidRequestMessage(
        `Signature check failed: ${signatureValidation.error}`
      )
    }
    return {
      valid: true
    }
  }
}
