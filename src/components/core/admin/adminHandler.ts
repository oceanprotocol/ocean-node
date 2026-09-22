import { SignedCommand, IValidateAdminCommandHandler } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildRateLimitReachedResponse,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { checkSingleCredential } from '../../../utils/credentials.js'
import { CREDENTIALS_TYPES } from '../../../@types/DDO/Credentials.js'
import { BaseHandler } from '../handler/handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { CommonValidation } from '../../../utils/validators.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { normalizeCommandAddresses } from '../../../utils/evmAddress.js'

// Membership test for the node's admin set: the ALLOWED_ADMINS address list first, then
// each configured admin access list (ALLOWED_ADMINS_LIST), per chain. Says nothing about
// authentication — the caller must have already proven it owns `address` (signature or
// auth token). Exported because handlers outside the admin family (SERVICE_STOP) also
// grant the node operator a privileged path and must not re-implement these checks.
export async function isAllowedAdminAddress(
  allowedAdmins: { addresses: string[]; accessLists: any } | null | undefined,
  address: string
): Promise<boolean> {
  if (!allowedAdmins || !address) {
    return false
  }
  const { addresses, accessLists } = allowedAdmins
  const isListedAddress = await checkSingleCredential(
    { type: CREDENTIALS_TYPES.ADDRESS, values: addresses },
    address,
    null
  )
  if (isListedAddress) {
    return true
  }
  if (accessLists) {
    for (const chainId of Object.keys(accessLists)) {
      const isOnAccessList = await checkSingleCredential(
        {
          type: CREDENTIALS_TYPES.ACCESS_LIST,
          chainId: parseInt(chainId),
          accessList: accessLists[chainId]
        },
        address,
        null
      )
      if (isOnAccessList) {
        return true
      }
    }
  }
  return false
}

export abstract class AdminCommandHandler
  extends BaseHandler
  implements IValidateAdminCommandHandler
{
  async verifyParamsAndRateLimits(task: SignedCommand): Promise<P2PCommandResponse> {
    // Same ingress normalization as CommandHandler: the admin `address` is matched against
    // ALLOWED_ADMINS / access lists, so its casing must not decide whether a call is admin.
    normalizeCommandAddresses(task)
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
      if (await isAllowedAdminAddress(oceanNode.getAdminAddresses(), address)) {
        return { valid: true, error: '' }
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
      'nonce',
      'address',
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
