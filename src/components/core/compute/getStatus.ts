import { Readable } from 'stream'
import { P2PCommandResponse } from '../../../@types/index.js'
import { C2DClusterInfo, ComputeJob } from '../../../@types/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { Handler } from '../handler.js'
import { ComputeGetStatusCommand } from '../../../@types/commands.js'
import { getConfiguration } from '../../../utils/config.js'
import { C2DEngine } from '../../c2d/compute_engines.js'

export class ComputeGetStatusHandler extends Handler {
  async handle(task: ComputeGetStatusCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'ComputeGetStatusCommand received with arguments: ' +
          JSON.stringify(task, null, 2),
        true
      )
      if (!task.consumerAddress && !task.jobId && !task.did) {
        const error = `Missing jobId or consumerAddress or did`
        CORE_LOGGER.logMessage(error, true)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error
          }
        }
      }
      const response: ComputeJob[] = []
      // two scenarios here:
      // 1. if we have a jobId, then we know what C2D Cluster to query
      // 2. if not, we query all clusters using owner and/or did
      let allC2dClusters: C2DClusterInfo[] = (await getConfiguration()).c2dClusters
      let jobId = null
      if (task.jobId) {
        // split jobId (which is already in hash-jobId format) and get the hash
        // then get jobId which might contain dashes as well
        const index = task.jobId.indexOf('-')
        const hash = task.jobId.slice(0, index)
        allC2dClusters = allC2dClusters.filter((arr) => arr.hash === hash)
        jobId = task.jobId.slice(index + 1)
      }
      for (const cluster of allC2dClusters) {
        const engine = await C2DEngine.getC2DByHash(cluster.hash)
        const jobs = await engine.getComputeJobStatus(
          task.consumerAddress,
          task.did,
          jobId
        )
        response.push(...jobs)
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
