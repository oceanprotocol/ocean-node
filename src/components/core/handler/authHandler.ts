import { CommandHandler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { ReadableString } from '../../P2P/handlers.js'
import { Command } from '../../../@types/commands.js'
import { Readable } from 'stream'
import { checkNonce, NonceResponse } from '../utils/nonceHandler.js'
import jwt from 'jsonwebtoken'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { errorSummary } from '../../../utils/logging/redact.js'
import {
  DISALLOWED_TOKEN_SCOPE_COMMANDS,
  MAX_TOKEN_AUDIENCE_ENTRIES,
  MAX_TOKEN_SCOPE_ENTRIES,
  SUPPORTED_PROTOCOL_COMMANDS
} from '../../../utils/constants.js'
import { AUTH_TOKEN_VERSION } from '../../../utils/crypt.js'
import { peerIdFromString } from '@libp2p/peer-id'

export interface AuthMessage {
  address: string
  nonce: string
  signature: string
}

export interface CreateAuthTokenCommand extends AuthMessage, Command {
  validUntil?: number | null
  chainId?: string | null
  // v2 scoped auth tokens (plan §5.1). node peerIds / PROTOCOL_COMMANDS values. Omitted ⇒
  // unrestricted; explicit [] is rejected (§5.3).
  audience?: string[]
  scope?: string[]
}

// Small positive skew allowed on the validUntil cap: the client signs an absolute timestamp
// against its own clock (plan §5.2 / §13).
const VALID_UNTIL_SKEW_MS = 60_000

// Validates audience/scope/validUntil for a create-auth-token request and resolves the stored
// expiry. Returns `{ error }` (→ HTTP 400) on any violation, otherwise the derived shape.
function validateScopedTokenRequest(
  task: CreateAuthTokenCommand,
  createdAt: number,
  maxLifetimeMs: number
):
  | { error: string }
  | {
      isV2: boolean
      audience?: string[]
      scope?: string[]
      signedValidUntil?: number
      storedValidUntil: number
    } {
  const { audience, scope } = task

  // Reject explicit empty arrays — "unrestricted" is the field being ABSENT, never [] (§5.3).
  if (audience !== undefined) {
    if (!Array.isArray(audience) || audience.length === 0) {
      return {
        error: 'empty audience is not allowed; omit the field for unrestricted'
      }
    }
    if (audience.length > MAX_TOKEN_AUDIENCE_ENTRIES) {
      return { error: `audience exceeds the maximum of ${MAX_TOKEN_AUDIENCE_ENTRIES}` }
    }
    for (const peer of audience) {
      if (typeof peer !== 'string') {
        return { error: 'audience entries must be peerId strings' }
      }
      try {
        peerIdFromString(peer)
      } catch {
        return { error: `audience entry is not a valid peerId: ${peer}` }
      }
    }
  }

  if (scope !== undefined) {
    if (!Array.isArray(scope) || scope.length === 0) {
      return { error: 'empty scope is not allowed; omit the field for unrestricted' }
    }
    if (scope.length > MAX_TOKEN_SCOPE_ENTRIES) {
      return { error: `scope exceeds the maximum of ${MAX_TOKEN_SCOPE_ENTRIES}` }
    }
    for (const cmd of scope) {
      if (typeof cmd !== 'string' || !SUPPORTED_PROTOCOL_COMMANDS.includes(cmd)) {
        return { error: `command ${cmd} is not a recognized protocol command` }
      }
      if (DISALLOWED_TOKEN_SCOPE_COMMANDS.includes(cmd)) {
        return { error: `command ${cmd} not allowed in token scope` }
      }
    }
  }

  const hasAudience = Array.isArray(audience) && audience.length > 0
  const hasScope = Array.isArray(scope) && scope.length > 0
  const validUntilProvided = task.validUntil !== undefined && task.validUntil !== null
  // Any of the three triggers v2 (plan §5.3).
  const isV2 = hasAudience || hasScope || validUntilProvided

  if (validUntilProvided) {
    const validUntil = task.validUntil as number
    if (!Number.isInteger(validUntil)) {
      return { error: 'validUntil must be an integer epoch-milliseconds timestamp' }
    }
    if (validUntil <= createdAt) {
      return { error: 'validUntil must be in the future' }
    }
    // Reject (never clamp) an over-cap lifetime, so signed == stored == claim (plan §3.3/§5.2).
    if (validUntil > createdAt + maxLifetimeMs + VALID_UNTIL_SKEW_MS) {
      return {
        error: `validUntil exceeds the maximum token lifetime (${Math.floor(
          maxLifetimeMs / 1000
        )}s)`
      }
    }
    return {
      isV2: true,
      audience: hasAudience ? audience : undefined,
      scope: hasScope ? scope : undefined,
      signedValidUntil: validUntil,
      storedValidUntil: validUntil
    }
  }

  // validUntil omitted. If audience/scope were provided, v2 requires a signed validUntil (§5.3).
  if (isV2) {
    return { error: 'validUntil is required when audience or scope is set' }
  }

  // Legacy-style request: server sets an UNSIGNED default expiry (kills never-expiring tokens).
  return {
    isV2: false,
    storedValidUntil: createdAt + maxLifetimeMs
  }
}

export interface InvalidateAuthTokenCommand extends AuthMessage, Command {
  token: string
  chainId?: string | null
}

export class CreateAuthTokenHandler extends CommandHandler {
  validate(command: CreateAuthTokenCommand): ValidateParams {
    return validateCommandParameters(command, ['address', 'signature'])
  }

  async handle(task: CreateAuthTokenCommand): Promise<P2PCommandResponse> {
    const { address, nonce, signature } = task
    const nonceDb = (await this.getOceanNode().getDatabase()).nonce
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      const auth = this.getOceanNode().getAuth()
      const createdAt = Date.now()

      // Validate audience / scope / validUntil and resolve the stored expiry (plan §5.2–5.3).
      const scoped = validateScopedTokenRequest(task, createdAt, auth.getMaxTokenLifetimeMs())
      if ('error' in scoped) {
        return {
          stream: null,
          status: { httpStatus: 400, error: scoped.error }
        }
      }

      const issuerPeerId = this.getOceanNode().getKeyManager().getPeerIdString()

      // For v2, the signed message folds in version/audience/scope/exp — thread them into the
      // signature check so the consumer-signed bytes match. Legacy keeps the byte-identical path.
      const nonceCheckResult: NonceResponse = await checkNonce(
        this.getOceanNode().getConfig(),
        nonceDb,
        address,
        parseInt(nonce),
        signature,
        task.command,
        task.chainId,
        scoped.isV2
          ? {
              audience: scoped.audience,
              scope: scoped.scope,
              validUntil: scoped.signedValidUntil
            }
          : undefined
      )

      if (!nonceCheckResult.valid) {
        return {
          stream: null,
          status: { httpStatus: 401, error: nonceCheckResult.error }
        }
      }

      const jwtToken = await auth.getJWTToken(
        task.address,
        task.nonce,
        createdAt,
        signature,
        issuerPeerId,
        task.chainId,
        scoped.isV2
          ? {
              version: AUTH_TOKEN_VERSION,
              audience: scoped.audience,
              scope: scoped.scope,
              validUntil: scoped.signedValidUntil
            }
          : undefined
      )

      await auth.insertToken(
        task.address,
        jwtToken,
        scoped.storedValidUntil,
        createdAt,
        task.chainId
      )

      return {
        stream: Readable.from(JSON.stringify({ token: jwtToken })),
        status: { httpStatus: 200, error: null }
      }
    } catch (error) {
      CORE_LOGGER.error(`CreateAuthToken failed: ${errorSummary(error)}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: `Error creating auth token: ${error}` }
      }
    }
  }
}

export class InvalidateAuthTokenHandler extends CommandHandler {
  validate(command: InvalidateAuthTokenCommand): ValidateParams {
    return validateCommandParameters(command, ['address', 'signature', 'token'])
  }

  async handle(task: InvalidateAuthTokenCommand): Promise<P2PCommandResponse> {
    const { address, nonce, signature, token } = task
    const nonceDb = (await this.getOceanNode().getDatabase()).nonce
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      const nonceCheckResult = await checkNonce(
        this.getOceanNode().getConfig(),
        nonceDb,
        address,
        parseInt(nonce),
        signature,
        task.command,
        task.chainId
      )
      if (!nonceCheckResult.valid) {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid signature' }
        }
      }

      await this.getOceanNode().getAuth().invalidateToken(token)

      return {
        stream: new ReadableString(JSON.stringify({ success: true })),
        status: { httpStatus: 200, error: null }
      }
    } catch (error) {
      CORE_LOGGER.error(`InvalidateAuthToken failed: ${errorSummary(error)}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: `Error invalidating auth token: ${error}` }
      }
    }
  }
}

export interface ValidateAuthTokenCommand extends Command {
  token: string
}

export class ValidateAuthTokenHandler extends CommandHandler {
  validate(command: ValidateAuthTokenCommand): ValidateParams {
    return validateCommandParameters(command, ['token'])
  }

  async handle(task: ValidateAuthTokenCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      const auth = this.getOceanNode().getAuth()
      let verified = true
      try {
        jwt.verify(task.token, auth.getJwtSecret())
      } catch {
        verified = false
      }
      const row = verified ? await auth.getLocalToken(task.token) : null
      const body = row
        ? {
            valid: true,
            validUntil: row.validUntil == null ? null : new Date(row.validUntil).getTime()
          }
        : { valid: false }

      return {
        stream: Readable.from(JSON.stringify(body)),
        status: { httpStatus: 200, error: null }
      }
    } catch (error) {
      CORE_LOGGER.error(`ValidateAuthToken failed: ${errorSummary(error)}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: `Error validating auth token: ${error}` }
      }
    }
  }
}
