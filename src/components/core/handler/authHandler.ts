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
import { MAX_AUTH_TOKEN_TTL_MS } from '../../../utils/constants.js'
import jwt from 'jsonwebtoken'

export interface AuthMessage {
  address: string
  nonce: string
  signature: string
}

export interface CreateAuthTokenCommand extends AuthMessage, Command {
  validUntil?: number | null
  chainId?: string | null
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
      const nonceCheckResult: NonceResponse = await checkNonce(
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
          status: { httpStatus: 401, error: nonceCheckResult.error }
        }
      }

      const createdAt = Date.now()
      const requested = Number(task.validUntil)
      const validUntil =
        Number.isFinite(requested) && requested > createdAt
          ? Math.min(requested, createdAt + MAX_AUTH_TOKEN_TTL_MS)
          : createdAt + MAX_AUTH_TOKEN_TTL_MS
      const issuerPeerId = this.getOceanNode().getKeyManager().getPeerIdString()
      const jwtToken = await this.getOceanNode()
        .getAuth()
        .getJWTToken(
          task.address,
          task.nonce,
          createdAt,
          signature,
          issuerPeerId,
          task.chainId
        )

      await this.getOceanNode()
        .getAuth()
        .insertToken(task.address, jwtToken, validUntil, createdAt, task.chainId)

      return {
        stream: Readable.from(JSON.stringify({ token: jwtToken })),
        status: { httpStatus: 200, error: null }
      }
    } catch (error) {
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
      return {
        stream: null,
        status: { httpStatus: 500, error: `Error validating auth token: ${error}` }
      }
    }
  }
}
