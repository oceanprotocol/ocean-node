import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { CommandHandler } from '../handler/handler.js'
import { ComputeStopCommand } from '../../../@types/commands.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeStopHandler extends CommandHandler {
  validate(command: ComputeStopCommand): ValidateParams {
    const validation = validateCommandParameters(command, ['jobId'])
    if (validation.valid) {
      if (!isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      }
    }
    return validation
  }

  async handle(task: ComputeStopCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }

    const authValidationResponse = await this.validateTokenOrSignature(
      task.authorization,
      task.consumerAddress,
      task.nonce,
      task.signature,
      String(task.consumerAddress + (task.jobId || ''))
    )
    if (authValidationResponse.status.httpStatus !== 200) {
      return authValidationResponse
    }

    try {
      // split jobId (which is already in hash-jobId format) and get the hash
      // then get jobId which might contain dashes as well
      const index = task.jobId.indexOf('-')
      const hash = task.jobId.slice(0, index)
      const jobId = task.jobId.slice(index + 1)
      // eslint-disable-next-line prefer-destructuring
      const agreementId = task.agreementId

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
      const response = await engine.stopComputeJob(
        jobId,
        task.consumerAddress,
        agreementId
      )

      CORE_LOGGER.logMessage(
        'StopComputeCommand Response: ' + JSON.stringify(response, null, 2),
        true
      )

      return {
        stream: Readable.from(JSON.stringify(response)),
        status: {
          httpStatus: 200
        }
      }
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
