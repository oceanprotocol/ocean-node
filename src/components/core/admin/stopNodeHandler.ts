import { AdminHandler } from './adminHandler.js'
import { AdminStopNodeCommand } from '../../../@types/commands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import {
  ValidateParams,
  buildInvalidParametersResponse
} from '../../httpRoutes/validateCommands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'

export class StopNodeHandler extends AdminHandler {
  validate(command: AdminStopNodeCommand): ValidateParams {
    return super.validate(command)
  }

  handle(task: AdminStopNodeCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return new Promise<P2PCommandResponse>((resolve, reject) => {
        resolve(buildInvalidParametersResponse(validation))
      })
    }
    CORE_LOGGER.logMessage(`Stopping node execution...`)
    setTimeout(() => {
      process.exit()
    }, 2000)
    return new Promise<P2PCommandResponse>((resolve, reject) => {
      resolve({
        status: { httpStatus: 200 },
        stream: new ReadableString('EXIT OK')
      })
    })
  }
}
