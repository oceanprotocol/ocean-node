import { Readable } from 'stream'
import { P2PCommandResponse } from '../../@types'
import {
  ComputeAsset,
  ComputeEnvironment,
  C2DClusterInfo,
  ComputeJob
} from '../../@types/C2D.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { Handler } from './handler.js'
import {
  ComputeGetEnvironmentsCommand,
  ComputeStartCommand,
  ComputeStopCommand,
  ComputeGetResultCommand,
  ComputeGetStatusCommand
} from '../../@types/commands.js'
import { getConfiguration } from '../../utils/config.js'
import { C2DEngine } from '../c2d/compute_engines.js'

export class ComputeGetEnvironmentsHandler extends Handler {
  async handle(task: ComputeGetEnvironmentsCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'GetComputeEnvironmentsCommand received with arguments: ' +
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

export class ComputeStartHandler extends Handler {
  async handle(task: ComputeStartCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'StartComputeCommand received with arguments: ' + JSON.stringify(task, null, 2),
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
      // TODO - hardcoded values.
      //  - validate algo & datasets
      //  - validate providerFees -> will generate chainId & agreementId & validUntil
      const chainId = 8996
      const agreementId = '0x1234'
      const validUntil = new Date().getTime() + 60
      const response = await engine.startComputeJob(
        assets,
        task.algorithm,
        task.output,
        task.consumerAddress,
        envId,
        validUntil,
        chainId,
        agreementId
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

export class ComputeGetStatusHandler extends Handler {
  async handle(task: ComputeGetStatusCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'ComputeGetStatusCommand received with arguments: ' +
          JSON.stringify(task, null, 2),
        true
      )
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

export class ComputeGetResultHandler extends Handler {
  async handle(task: ComputeGetResultCommand): Promise<P2PCommandResponse> {
    CORE_LOGGER.logMessage(
      'ComputeGetResultCommand received with arguments: ' + JSON.stringify(task, null, 2),
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
    try {
      return {
        stream: await engine.getComputeJobResult(task.consumerAddress, jobId, task.index),
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
