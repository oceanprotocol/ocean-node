import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { CommandHandler } from '../handler/handler.js'
import { ComputeGetResultCommand } from '../../../@types/commands.js'
import {
  buildInvalidRequestMessage,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeGetResultHandler extends CommandHandler {
  validate(command: ComputeGetResultCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'jobId',
      'index'
    ])
    if (validation.valid) {
      if (command.consumerAddress && !isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
      if (isNaN(command.index) || command.index < 0) {
        return buildInvalidRequestMessage('Invalid result index')
      }
    }
    return validation
  }

  async handle(task: ComputeGetResultCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    const authValidationResponse = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      String(task.consumerAddress + task.jobId + task.index.toString() + task.nonce)
    )
    if (authValidationResponse.status.httpStatus !== 200) {
      return authValidationResponse
    }

    // split jobId (which is already in hash-jobId format) and get the hash
    // then get jobId which might contain dashes as well
    const index = task.jobId.indexOf('-')
    const hash = task.jobId.slice(0, index)
    const jobId = task.jobId.slice(index + 1)

    // env might contain
    let engine
    try {
      engine = await this.getOceanNode().getC2DEngines().getC2DByHash(hash)
    } catch (e) {
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: 'Invalid C2D Environment'
        }
      }
    }
    try {
      const respStream = await engine.getComputeJobResult(
        task.consumerAddress,
        jobId,
        task.index
      )
      const response: P2PCommandResponse = {
        stream: respStream?.stream,
        status: {
          httpStatus: 200
        }
      }
      // need to pass the headers properly
      if (respStream?.headers) {
        response.status.headers = respStream?.headers
      }
      return response
    } catch (error) {
      CORE_LOGGER.error(error.message)
      return {
        stream: null,
        status: {
          httpStatus: 500,
          error: error.message
        }
      }
    }
  }
}
