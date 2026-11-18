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
import { errorSummary } from '../../../utils/logging/redact.js'
import { normalizeCommandAddresses, sameAddress } from '../../../utils/evmAddress.js'
import { isAddress } from 'ethers'

export abstract class AdminCommandHandler
  extends BaseHandler
  implements IValidateAdminCommandHandler
{
  // Whether this admin command accepts a bearer auth token (plan §16.2/§16.3). Default: NO —
  // every mutating admin command is signature-only (a fresh single-use nonce-bound signature).
  // Only the two read-only admin handlers (FetchConfig / GetLogs) override this to true.
  protected readonly allowAuthToken: boolean = false

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
    chainId?: string,
    // The bearer token, forwarded only for read-only admin commands (allowAuthToken). For every
    // mutating admin command this stays null and the request MUST be signature-authenticated.
    authorization?: string
  ): Promise<CommonValidation> {
    const oceanNode = this.getOceanNode()
    const auth = oceanNode.getAuth()
    if (!auth) {
      return {
        valid: false,
        error: 'Auth not configured'
      }
    }
    // Mutating admin commands never accept a token (plan §16.2): if one is presented, reject
    // explicitly rather than silently ignoring it.
    if (!this.allowAuthToken && authorization) {
      return {
        valid: false,
        error: 'this admin command requires a request signature, not an auth token'
      }
    }
    const token = this.allowAuthToken ? authorization : null
    const isAuthRequestValid = await auth.validateAuthenticationOrToken({
      token,
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
    // SECURITY (plan §16.3/§18.2): the ALLOWED_ADMINS gate must run against the AUTHENTICATED
    // address, not the raw `address` param. For the token path these can differ: a valid token
    // for a non-admin Z could be presented while `address` names admin A. Require BOTH — bind the
    // authenticated address to the claimed `address` AND evaluate the admin gate against the
    // authenticated address. (The signature path returns the address it verified, so it matches.)
    const authenticatedAddress = isAuthRequestValid.address ?? address
    if (address && !sameAddress(authenticatedAddress, address)) {
      return {
        valid: false,
        error: 'Authenticated address does not match the requested address'
      }
    }
    try {
      const allowedAdmins = oceanNode.getAdminAddresses()

      const { addresses, accessLists } = allowedAdmins
      let allowed = await checkSingleCredential(
        { type: CREDENTIALS_TYPES.ADDRESS, values: addresses },
        authenticatedAddress,
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
            CORE_LOGGER.warn(
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
            CORE_LOGGER.warn(
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
              authenticatedAddress,
              signer
            )
          } catch (error) {
            // Isolate per-chain failures (RPC rate limit / downtime) so one bad
            // chain does not abort the whole loop and deny an otherwise-valid admin.
            CORE_LOGGER.error(
              `Error checking admin access list for chain ${chainId}: ${errorSummary(error)}`
            )
            continue
          }
          if (allowed) {
            return { valid: true, error: '' }
          }
        }
      }

      const errorMsg = `The address which signed the message is not on the allowed admins list. Therefore signature ${signature} is rejected`
      // the signature stays out of the log. Keyed per command only: callers pick the signing
      // address, so per-address keys would neither throttle nor stay bounded
      CORE_LOGGER.throttled(
        `admin-denied:${command}`,
        'warn',
        `Admin command ${command} rejected: ${address} is not an allowed admin`
      )
      return { valid: false, error: errorMsg }
    } catch (e) {
      const errorMsg = `Error during signature validation: ${e}`
      CORE_LOGGER.error(
        `Admin signature validation failed for ${command}: ${errorSummary(e)}`
      )
      return { valid: false, error: errorMsg }
    }
  }

  async validate(command: SignedCommand): Promise<ValidateParams> {
    // A read-only admin command authorized by a bearer token (allowAuthToken) carries no
    // signature/nonce, so those params must NOT be required on the token path — otherwise the
    // request is rejected here before it can reach validateTokenOrSignature. The signature path
    // still requires nonce/address/signature. (The admin gate + §18.2 address binding run later.)
    const usingToken =
      this.allowAuthToken && !!command.authorization && !command.signature
    const requiredParams = usingToken ? [] : ['nonce', 'address', 'signature']
    const commandValidation = validateCommandParameters(command, requiredParams)
    if (!commandValidation.valid) {
      return buildInvalidRequestMessage(commandValidation.reason)
    }
    const isAuthRequestValid = await this.validateTokenOrSignature(
      command.address,
      command.nonce,
      command.signature,
      command.command,
      undefined,
      command.authorization
    )
    if (!isAuthRequestValid.valid) {
      return buildInvalidRequestMessage(
        `Signature check failed: ${isAuthRequestValid.error}`
      )
    }
    return { valid: true }
  }
}
