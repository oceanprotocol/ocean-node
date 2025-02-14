import { AdminCommand, IValidateAdminCommandHandler } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildRateLimitReachedResponse,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { validateAdminSignature } from '../../../utils/auth.js'
import { BaseHandler } from '../handler/handler.js'
import { CommonValidation } from '../../httpRoutes/requestValidator.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'

export abstract class AdminCommandHandler
  extends BaseHandler
  implements IValidateAdminCommandHandler
{
  async verifyParamsAndRateLimits(task: AdminCommand): Promise<P2PCommandResponse> {
    if (!(await this.checkRateLimit())) {
      return buildRateLimitReachedResponse()
    }
    // then validate the command arguments
    const validation = await this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }

    // all good!
    return {
      stream: new ReadableString('OK'),
      status: { httpStatus: 200, error: null }
    }
  }

  async validate(command: AdminCommand): Promise<ValidateParams> {
    console.log('validate admin command')
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    console.log('before signatureValidation')
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
