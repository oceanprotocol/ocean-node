import { Readable } from 'stream'
import { P2PCommandResponse } from '../../@types'
import { ComputeAsset, ComputeEnvironment } from '../../@types/C2D.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { Handler } from './handler.js'
import {
  GetComputeEnvironmentsCommand,
  StartComputeCommand
} from '../../@types/commands.js'
import { getConfiguration } from '../../utils/config.js'
import { C2DEngine } from '../c2d/compute_engines.js'

export class GetComputeEnvironmentsHandler extends Handler {
  async handle(task: GetComputeEnvironmentsCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'GetComputeEnvironmentsCommand recieved with arguments: ' +
          JSON.stringify(task, null, 2),
        true
      )
      const response: ComputeEnvironment[] = []
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

export class StartComputeHandler extends Handler {
  async handle(task: StartComputeCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'StartComputeCommand recieved with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      // split compute env (which is already in hash-envId format) and get the hash
      // then get env which might contain dashes as well
      const index = task.environment.indexOf('-')
      const hash = task.environment.slice(0, index)
      const envId = task.environment.slice(index + 1)

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
      const assets: ComputeAsset[] = [task.dataset]
      if (task.additionalDatasets) assets.push(...task.additionalDatasets)
      // TODO - hardcoded values
      const validUntil = new Date().getTime() + 60
      const response = await engine.startComputeJob(
        assets,
        task.algorithm,
        task.output,
        task.consumerAddress,
        envId,
        validUntil
      )

      CORE_LOGGER.logMessage(
        'StartComputeCommand Response: ' + JSON.stringify(response, null, 2),
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
