import { Readable } from 'stream'
import { P2PCommandResponse } from '../../@types'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { Handler } from './handler.js'
import { GetEnvironmentsCommand } from '../../@types/commands.js'
import { getConfiguration } from '../../utils/config.js'
import axios from 'axios'

export class GetEnvironmentsHandler extends Handler {
  async handle(task: GetEnvironmentsCommand): Promise<P2PCommandResponse> {
    try {
      CORE_LOGGER.logMessage(
        'File Info Request recieved with arguments: ' + JSON.stringify(task, null, 2),
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
