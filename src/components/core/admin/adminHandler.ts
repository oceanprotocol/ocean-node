import { Handler } from '../handler.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { AdminCommand } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage
} from '../../httpRoutes/validateCommands.js'
import { validateSignature } from '../../../utils/auth.js'

export abstract class AdminHandler extends Handler {
  validate(command: AdminCommand): ValidateParams {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      const errorMsg = `Command validation failed: ${JSON.stringify(commandValidation)}`
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
    }
    if (!validateSignature(command.expiryTimestamp, command.signature)) {
      const errorMsg = 'Expired authentication or invalid signature'
      CORE_LOGGER.logMessage(errorMsg)
      return buildInvalidRequestMessage(errorMsg)
    }
    return commandValidation
  }
}
