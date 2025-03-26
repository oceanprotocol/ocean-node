import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { ComputeJob } from '../../../@types/C2D/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { CommandHandler } from '../handler/handler.js'
import { ComputeGetStatusCommand } from '../../../@types/commands.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class ComputeGetStatusHandler extends CommandHandler {
  validate(command: ComputeGetStatusCommand): ValidateParams {
    const validation = validateCommandParameters(command, [])
    if (validation.valid) {
      if (command.consumerAddress && !isAddress(command.consumerAddress)) {
        return buildInvalidRequestMessage(
          'Parameter : "consumerAddress" is not a valid web3 address'
        )
      } else if (!command.consumerAddress && !command.jobId && !command.agreementId) {
        const error = 'Missing one of ["jobId","consumerAddress","agreementId"]'
        CORE_LOGGER.logMessage(error, true)
        return buildInvalidRequestMessage(error)
      }
    }
    return validation
  }

  async handle(task: ComputeGetStatusCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    try {
      const response: ComputeJob[] = []
      // two scenarios here:
      // 1. if we have a jobId, then we know what C2D Cluster to query
      // 2. if not, we query all clusters using owner and/or did
      let jobId = null
      let engines
      if (task.jobId) {
        // split jobId (which is already in hash-jobId format) and get the hash
        // then get jobId which might contain dashes as well
        const index = task.jobId.indexOf('-')
        if (index > 0) {
          const hash = task.jobId.slice(0, index)
          engines = [await this.getOceanNode().getC2DEngines().getC2DByHash(hash)]
          jobId = task.jobId.slice(index + 1)
        } else {
          engines = await this.getOceanNode().getC2DEngines().getAllEngines()
        }
      } else {
        engines = await this.getOceanNode().getC2DEngines().getAllEngines()
      }

      for (const engine of engines) {
        const jobs = await engine.getComputeJobStatus(
          task.consumerAddress,
          task.agreementId,
          jobId
        )

        if (jobs && jobs.length > 0) response.push(...jobs)
      }
      CORE_LOGGER.logMessage(
        'ComputeGetStatusCommand Response: ' + JSON.stringify(response, null, 2),
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
