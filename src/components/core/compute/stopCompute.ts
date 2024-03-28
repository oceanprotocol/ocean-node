import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler/handler.js'
import { ComputeStopCommand } from '../../../@types/commands.js'
import { C2DEngine } from '../../c2d/compute_engines.js'
import {
  ValidateParams,
  buildInvalidParametersResponse,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeStopHandler extends Handler {
  validate(command: ComputeStopCommand): ValidateParams {
    const validation = validateCommandParameters(command, [
      'consumerAddress',
      'signature',
      'nonce',
      'jobId'
    ])
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
    const validation = this.validate(task)
    if (!validation.valid) {
      return buildInvalidParametersResponse(validation)
    }
    try {
      // split jobId (which is already in hash-jobId format) and get the hash
      // then get jobId which might contain dashes as well
      const index = task.jobId.indexOf('-')
      const hash = task.jobId.slice(0, index)
      const jobId = task.jobId.slice(index + 1)

      // env might contain
      let engine
      try {
        engine = await C2DEngine.getC2DByHash(hash)
      } catch (e) {
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error: 'Invalid C2D Environment'
          }
        }
      }
      const response = await engine.stopComputeJob(jobId, task.consumerAddress)

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
