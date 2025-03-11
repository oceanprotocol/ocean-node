import { P2PCommandResponse } from '../../../@types/index.js'
import { PolicyServerPassthroughCommand } from '../../../@types/commands.js'
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
