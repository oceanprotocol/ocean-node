import { P2PCommandResponse } from '../../../@types/index.js'
import {
  PolicyServerPassthroughCommand,
  PolicyServerInitializeCommand
} from '../../../@types/commands.js'
import { Readable } from 'stream'
import { CommandHandler } from './handler.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'

import { PolicyServer } from '../../policyServer/index.js'

export class PolicyServerPassthroughHandler extends CommandHandler {
  validate(command: PolicyServerPassthroughCommand): ValidateParams {
    if (!command.policyServerPassthrough)
      return buildInvalidRequestMessage(
        'Invalid Request: missing policyServerPassthrough field!'
      )
    const validation = validateCommandParameters(command, []) // all optional? weird
    return validation
  }

  async handle(task: PolicyServerPassthroughCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    // policyServer check
    const policyServer = new PolicyServer()
    const policyStatus = await policyServer.passThrough(task.policyServerPassthrough)
    if (!policyStatus.success) {
      return {
        stream: null,
        status: {
          httpStatus: policyStatus.httpStatus,
          error: policyStatus.message
        }
      }
    } else {
      return {
        stream: Readable.from(policyStatus.message),
        status: {
          httpStatus: policyStatus.httpStatus
        }
      }
    }
  }
}

export class PolicyServerInitializeHandler extends CommandHandler {
  validate(command: PolicyServerInitializeCommand): ValidateParams {
    if (!command.policyServer)
      return buildInvalidRequestMessage('Invalid Request: missing policyServer field!')
    const validation = validateCommandParameters(command, [
      'documentId',
      'serviceId',
      'consumerAddress'
    ]) // all optional? weird
    return validation
  }

  async handle(task: PolicyServerInitializeCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    // resolve DDO first
    try {
      const ddo = await this.getOceanNode().getDatabase().ddo.retrieve(task.documentId)
      if (!ddo) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Not found' }
        }
      }
      // policyServer check
      const policyServer = new PolicyServer()
      const policyStatus = await policyServer.initializePSVerification(
        task.documentId,
        ddo,
        task.serviceId,
        task.consumerAddress,
        task.policyServer
      )
      if (!policyStatus.success) {
        return {
          stream: null,
          status: {
            httpStatus: policyStatus.httpStatus,
            error: policyStatus.message
          }
        }
      } else {
        return {
          stream: Readable.from(policyStatus.message),
          status: {
            httpStatus: policyStatus.httpStatus
          }
        }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
