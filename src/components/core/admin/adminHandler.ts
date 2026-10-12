import { SignedCommand, IValidateAdminCommandHandler } from '../../../@types/commands.js'
import {
  ValidateParams,
  validateCommandParameters,
  buildInvalidRequestMessage,
  buildRateLimitReachedResponse,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import {
  checkSingleCredential,
  checkCredentialOnAccessList
} from '../../../utils/credentials.js'
import { CREDENTIALS_TYPES } from '../../../@types/DDO/Credentials.js'
import { BaseHandler } from '../handler/handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { CommonValidation } from '../../../utils/validators.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { normalizeCommandAddresses } from '../../../utils/evmAddress.js'
import { isAddress } from 'ethers'

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
      const allowedAdmins = oceanNode.getAdminAddresses()

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
          // Need an on-chain signer/provider to call balanceOf on the access list
          // contract. getBlockchain() returns null when that chain has no RPC configured.
          const blockchain = oceanNode.getBlockchain(parseInt(chainId))
          if (!blockchain) {
            CORE_LOGGER.error(
              `Cannot check admin access list for chain ${chainId}: no RPC configured for that chain. Skipping.`
            )
            continue
          }
          // Fail closed on misconfiguration: an empty or malformed contract address
          // would make checkAddressOnAccessListWithSigner return `true` (it treats a
          // falsy address as "no access list"), silently authorizing ANY authenticated
          // caller as admin. Only keep well-formed contract addresses.
          const validContracts = accessLists[chainId].filter((addr: string) =>
            isAddress(addr)
          )
          if (validContracts.length === 0) {
            CORE_LOGGER.error(
              `No valid access list contract address configured for admin check on chain ${chainId}. Skipping.`
            )
            continue
          }
          try {
            const signer = await blockchain.getSigner()
            // Pass only the validated contracts for this chain; checkCredentialOnAccessList
            // iterates the array and checks each one with an on-chain balanceOf.
            allowed = await checkCredentialOnAccessList(
              { [chainId]: validContracts },
              chainId,
              address,
              signer
            )
          } catch (error) {
            // Isolate per-chain failures (RPC rate limit / downtime) so one bad
            // chain does not abort the whole loop and deny an otherwise-valid admin.
            CORE_LOGGER.error(
              `Error checking admin access list for chain ${chainId}: ${error}`
            )
            continue
          }
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
