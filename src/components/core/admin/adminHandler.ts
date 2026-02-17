import { SignedCommand, IValidateAdminCommandHandler } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildRateLimitReachedResponse,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { getAdminAddresses } from '../../../utils/auth.js'
import { checkSingleCredential } from '../../../utils/credentials.js'
import { CREDENTIALS_TYPES } from '../../../@types/DDO/Credentials.js'
import { BaseHandler } from '../handler/handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { CommonValidation } from '../../../utils/validators.js'
import { getConfiguration } from '../../../utils/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

export abstract class AdminCommandHandler
  extends BaseHandler
  implements IValidateAdminCommandHandler
{
  async verifyParamsAndRateLimits(task: SignedCommand): Promise<P2PCommandResponse> {
    if (!(await this.checkRateLimit(task.caller))) {
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

  async validateTokenOrSignature(
    address: string,
    nonce: string,
    signature: string,
    command: string,
    chainId?: string
  ): Promise<CommonValidation> {
    const oceanNode = this.getOceanNode()
    const auth = oceanNode.getAuth()
    if (!auth) {
      return {
        valid: false,
        error: 'Auth not configured'
      }
    }
    const isAuthRequestValid = await auth.validateAuthenticationOrToken({
      token: null,
      address,
      nonce,
      signature,
      command,
      chainId
    })
    if (!isAuthRequestValid.valid) {
      return {
        valid: false,
        error: isAuthRequestValid.error
      }
    }
    try {
      const config = await getConfiguration()
      const allowedAdmins = await getAdminAddresses(config)

      const { addresses, accessLists } = allowedAdmins
      let allowed = await checkSingleCredential(
        { type: CREDENTIALS_TYPES.ADDRESS, values: addresses },
        address,
        null
      )
      if (allowed) {
        return { valid: true, error: '' }
      }
      if (accessLists) {
        for (const chainId of Object.keys(accessLists)) {
          allowed = await checkSingleCredential(
            {
              type: CREDENTIALS_TYPES.ACCESS_LIST,
              chainId: parseInt(chainId),
              accessList: accessLists[chainId]
            },
            address,
            null
          )
          if (allowed) {
            return { valid: true, error: '' }
          }
        }
      }

      const errorMsg = `The address which signed the message is not on the allowed admins list. Therefore signature ${signature} is rejected`
      CORE_LOGGER.logMessage(errorMsg)
      return { valid: false, error: errorMsg }
    } catch (e) {
      const errorMsg = `Error during signature validation: ${e}`
      CORE_LOGGER.error(errorMsg)
      return { valid: false, error: errorMsg }
    }
  }

  async validate(command: SignedCommand): Promise<ValidateParams> {
    const commandValidation = validateCommandParameters(command, [
      'expiryTimestamp',
      'signature'
    ])
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    const isAuthRequestValid = await this.validateTokenOrSignature(
      command.address,
      command.nonce,
      command.signature,
      command.command
    )
    if (!isAuthRequestValid.valid) {
      return buildInvalidRequestMessage(
        `Signature check failed: ${isAuthRequestValid.error}`
      )
    }
    return { valid: true }
  }
}
