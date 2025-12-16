import { AdminCommandHandler } from './adminHandler.js'
import { AdminFetchConfigCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { loadConfigFromFile } from '../../../utils/config/index.js'

export class FetchConfigHandler extends AdminCommandHandler {
  async validate(command: AdminFetchConfigCommand): Promise<ValidateParams> {
    return await super.validate(command)
  }

  async handle(task: AdminFetchConfigCommand): Promise<P2PCommandResponse> {
    console.log({ task, message: 'FETCH_CONFIG_P2P_COMMAND' })
    const validation = await this.validate(task)
    console.log({ validation, message: 'FETCH_CONFIG_P2P_COMMAND' })
    if (!validation.valid) {
      return new Promise<P2PCommandResponse>((resolve) => {
        resolve(buildInvalidParametersResponse(validation))
      })
    }

    try {
      const config = loadConfigFromFile()
      config.keys.privateKey = '[*** HIDDEN CONTENT ***]'

      console.log({
        responseConfig: JSON.stringify(config),
        message: 'FETCH_CONFIG_P2P_COMMAND'
      })
      return new Promise<P2PCommandResponse>((resolve) => {
        resolve({
          status: { httpStatus: 200 },
          stream: new ReadableString(JSON.stringify(config))
        })
      })
    } catch (error) {
      return new Promise<P2PCommandResponse>((resolve) => {
        resolve({
          status: { httpStatus: 500, error: `Error fetching config: ${error.message}` },
          stream: null
        })
      })
    }
  }
}
