import { Readable } from 'stream'
import { P2PCommandResponse } from '../../@types'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { Handler } from './handler.js'
import { GetEnvironmentsCommand } from '../../@types/commands.js'
import { InitializeComputeCommand } from '../../@types/C2D'
import { getConfiguration } from '../../utils/config.js'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'
import { DDO } from '../../@types/DDO/DDO.js'
import axios from 'axios'
import { validateComputeProviderFee } from './utils/feesHandler.js'
import { getJsonRpcProvider } from '../../utils/blockchain.js'

export class GetEnvironmentsHandler extends Handler {
  async handle(task: GetEnvironmentsCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'Get C2D Envs Request recieved with arguments: ' + JSON.stringify(task, null, 2),
        true
      )
      const response: any[] = []
      const config = await getConfiguration()
      const { c2dClusters } = config
      for (const cluster of c2dClusters) {
        CORE_LOGGER.logMessage(
          `Requesting environment from Operator URL: ${cluster.url}`,
          true
        )
        const url = `${cluster.url}api/v1/operator/environments?chain_id=${task.chainId}`
        const { data } = await axios.get(url)
        const { hash } = cluster
        for (const item of data) {
          item.id = hash + '-' + item.id
        }
        response.push(...data)
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

export class InitializeComputeHandler extends Handler {
  validateTimestamp(value: number) {
    // in miliseconds
    const timestampNow = new Date().getTime() / 1000
    const validUntil = new Date(value).getTime() / 1000

    return validUntil > timestampNow
  }

  checksC2DEnv(computeEnv: string, c2dEnvsWithHash: any[]): boolean {
    for (const c of c2dEnvsWithHash) {
      if (c.id === computeEnv) {
        return true
      }
    }
    return false
  }

  getServiceById(ddo: DDO, serviceId: string) {
    try {
      return ddo.services.filter((service) => service.id === serviceId)[0]
    } catch (err) {
      CORE_LOGGER.error(`Service was not found: ${err}`)
    }
  }

  async handle(task: InitializeComputeCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'Initialize Compute Request recieved with arguments: ' +
          JSON.stringify(task, null, 2),
        true
      )

      const { validUntil } = task.compute
      if (!this.validateTimestamp(validUntil)) {
        const errorMsg = `Error validating validUntil ${validUntil}. It is not in the future.`
        CORE_LOGGER.error(errorMsg)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: errorMsg
          }
        }
      }

      const c2dEnvTask: GetEnvironmentsCommand = {
        chainId: task.chainId,
        command: PROTOCOL_COMMANDS.GET_COMPUTE_ENVIRONMENTS
      }

      const req = await new GetEnvironmentsHandler(this.getOceanNode()).handle(c2dEnvTask)

      const resp = await streamToString(req.stream as Readable)
      const c2dEnvs = JSON.parse(resp)

      if (!this.checksC2DEnv(task.compute.env, c2dEnvs)) {
        const errorMsg = `Compute env was not found.`
        CORE_LOGGER.error(errorMsg)
        return {
          stream: null,
          status: {
            httpStatus: 400,
            error: errorMsg
          }
        }
      }

      const listOfAssest = [...task.datasets, ...[task.algorithm]]
      const node = this.getOceanNode()
      let approvedParams: any = {
        algorithm: {},
        datasets: []
      }

      for (const asset of listOfAssest) {
        if (!asset.transferTxId) {
          continue
        }
        try {
          const ddo = (await node.getDatabase().ddo.retrieve(asset.documentId)) as DDO
          if (ddo.id === task.algorithm.documentId) {
            if (ddo.metadata.type !== 'algorithm') {
              const errorMsg = `DID is not a valid algorithm`
              CORE_LOGGER.error(errorMsg)
              return {
                stream: null,
                status: {
                  httpStatus: 400,
                  error: errorMsg
                }
              }
            }
          }
          const service = this.getServiceById(ddo, asset.serviceId)
          const provider = await getJsonRpcProvider(task.chainId)

          const resultValidation = await validateComputeProviderFee(
            provider,
            asset.transferTxId,
            task.compute.env,
            ddo,
            service,
            task.compute.validUntil,
            task.consumerAddress
          )
          if (ddo.metadata.type === 'algorithm') {
            approvedParams = {
              algorithm: resultValidation[1]
            }
          } else {
            approvedParams.datasets.push(resultValidation[1])
          }
        } catch (error) {
          CORE_LOGGER.error(`Unable to find DDO locally: ${error}`)
        }
      }

      return {
        stream: Readable.from(JSON.stringify(approvedParams)),
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
