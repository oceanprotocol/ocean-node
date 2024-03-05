import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler.js'
import { ComputeStopCommand } from '../../../@types/commands.js'
import { C2DEngine } from '../../c2d/compute_engines.js'

export class ComputeStopHandler extends Handler {
  async handle(task: ComputeStopCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'StopComputeCommand received with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
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
