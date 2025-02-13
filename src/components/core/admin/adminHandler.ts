import { AdminCommand } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { validateAdminSignature } from '../../../utils/auth.js'
import { Handler } from '../handler/handler.js'
import { CommonValidation } from '../../httpRoutes/requestValidator.js'

export abstract class AdminHandler extends Handler {
  validate(command: AdminCommand): ValidateParams {
    let validation = { valid: false }
    async function fn() {
      validation = await this.validateAdminCommand(command)
    }
    ;(async () => await fn())()
    return validation
  }

  async validateAdminCommand(command: AdminCommand): Promise<ValidateParams> {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    const signatureValidation: CommonValidation = await validateAdminSignature(
      command.expiryTimestamp,
      command.signature
    )
    console.log('Admin handler validation: ', signatureValidation)
    if (!signatureValidation.valid) {
      return buildInvalidRequestMessage(
        `Signature check failed: ${signatureValidation.error}`
      )
    }
    return { valid: true }
  }
}
