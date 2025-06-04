import { CommandHandler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { ReadableString } from '../../P2P/handlers.js'
import { Command } from '../../../@types/commands.js'
import { Readable } from 'stream'

export interface CreateAuthTokenCommand extends Command {
  address: string
  signature: string
  validUntil?: number | null
}

export interface InvalidateAuthTokenCommand extends Command {
  address: string
  signature: string
  token: string
}

export class CreateAuthTokenHandler extends CommandHandler {
  validate(command: CreateAuthTokenCommand): ValidateParams {
    return validateCommandParameters(command, ['address', 'signature'])
  }

  async handle(task: CreateAuthTokenCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      const isValid = await this.getOceanNode()
        .getAuth()
        .validateSignature(task.signature, task.address)
      if (!isValid) {
        return {
          stream: null,
          status: { httpStatus: 401, error: 'Invalid signature' }
        }
      }

      const createdAt = Date.now()
      const jwtToken = this.getOceanNode().getAuth().getJWTToken(task.address, createdAt)

      await this.getOceanNode()
        .getAuth()
        .insertToken(task.address, jwtToken, task.validUntil, createdAt)

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
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    try {
      const isValid = await this.getOceanNode()
        .getAuth()
        .validateSignature(task.signature, task.address)
      if (!isValid) {
        return {
          stream: null,
          status: { httpStatus: 400, error: 'Invalid signature' }
        }
      }

      await this.getOceanNode().getAuth().invalidateToken(task.token)

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
