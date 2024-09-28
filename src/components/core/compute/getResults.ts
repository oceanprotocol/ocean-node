import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler/handler.js'
import { ComputeGetResultCommand } from '../../../@types/commands.js'
import { checkNonce, NonceResponse } from '../utils/nonceHandler.js'
import {
  buildInvalidRequestMessage,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeGetResultHandler extends Handler {
  validate(command: ComputeGetResultCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
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

    let error = null

    // signature message to check against
    const message = task.consumerAddress + task.jobId + task.index.toString() + task.nonce
    const nonceCheckResult: NonceResponse = await checkNonce(
      this.getOceanNode().getDatabase().nonce,
      task.consumerAddress,
      parseInt(task.nonce),
      task.signature,
      message // task.jobId + task.index.toString()
    )

    if (!nonceCheckResult.valid) {
      // eslint-disable-next-line prefer-destructuring
      error = nonceCheckResult.error
    }

    if (error) {
      CORE_LOGGER.logMessage(error, true)
      return {
        stream: null,
        status: {
          httpStatus: 400,
          error
        }
      }
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
      const anyResp: any = respStream as any
      const response: P2PCommandResponse = {
        stream: respStream,
        status: {
          httpStatus: 200
        }
      }
      // need to pass the headers properly
      if (anyResp.headers) {
        response.status.headers = anyResp.headers
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
