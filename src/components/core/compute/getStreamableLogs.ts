import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { CommandHandler } from '../handler/handler.js'
import { ComputeGetStreamableLogsCommand } from '../../../@types/commands.js'
import { checkNonce, NonceResponse } from '../utils/nonceHandler.js'
import { Stream } from 'stream'
import {
  buildInvalidRequestMessage,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeGetStreamableLogsHandler extends CommandHandler {
  validate(command: ComputeGetStreamableLogsCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'jobId'
    ])
    if (validation.valid) {
      if (command.consumerAddress && !isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
    }
    return validation
  }

  async handle(task: ComputeGetStreamableLogsCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    const oceanNode = this.getOceanNode()
    let error = null

    // signature message to check against
    const message = task.consumerAddress + task.jobId + task.nonce
    const nonceCheckResult: NonceResponse = await checkNonce(
      oceanNode.getDatabase().nonce,
      task.consumerAddress,
      parseInt(task.nonce),
      task.signature,
      message
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
      engine = await oceanNode.getC2DEngines().getC2DByHash(hash)
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
      const respStream = await engine.getStreamableLogs(jobId)
      if (!respStream) {
        return {
          stream: null,
          status: {
            httpStatus: 404
          }
        }
      }
      const response: P2PCommandResponse = {
        stream: respStream as unknown as Stream,
        status: {
          httpStatus: 200
        }
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
