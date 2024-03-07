import { GetAdminListCommand } from '../../../@types/commands.js'
import { Handler } from '../handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { getConfiguration } from '../../../utils/index.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { Readable } from 'stream'

const regex: RegExp = /^(0x)?[0-9a-fA-F]{40}$/

export class AdminHandler extends Handler {
  async handle(task: GetAdminListCommand): Promise<P2PCommandResponse> {
    try {
      const config = await getConfiguration()
      if (!config.allowedAdmins) {
        CORE_LOGGER.log(
          LOG_LEVELS_STR.LEVEL_INFO,
          `Allowed admins list is empty because env var is not set.`
        )

        return {
          stream: Readable.from(JSON.stringify({ response: [] })),
          status: { httpStatus: 200 }
        }
      }

      for (const address of config.allowedAdmins) {
        // should we return the good ones instead?
        if (regex.test(address) === false) {
          CORE_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Invalid format for ETH address from ALLOWED ADMINS.`
          )

          return {
            stream: null,
            status: { httpStatus: 400 }
          }
        }
      }
      return {
        stream: Readable.from(JSON.stringify({ response: config.allowedAdmins })),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      CORE_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, `Error: ${error}`)
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
