import { Readable } from 'stream'
import { P2PCommandResponse } from '../../@types'
import { C2DEnvironment } from '../../@types/C2D.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { Handler } from './handler.js'
import { GetEnvironmentsCommand } from '../../@types/commands.js'
import { getConfiguration } from '../../utils/config.js'
import { C2DEngine } from '../c2d/compute_engines.js'

export class GetEnvironmentsHandler extends Handler {
  async handle(task: GetEnvironmentsCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'File Info Request recieved with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      const response: C2DEnvironment[] = []
      const config = await getConfiguration()
      const { c2dClusters } = config

      for (const cluster of c2dClusters) {
        const engine = C2DEngine.getC2DClass(cluster)
        const environments = await engine.getComputeEnvironments(task.chainId)
        response.push(...environments)
      }

      CORE_LOGGER.logMessage(
        'File Info Response: ' + JSON.stringify(response, null, 2),
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
