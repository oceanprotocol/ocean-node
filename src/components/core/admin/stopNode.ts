import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { AdminCommand } from '../../../@types/commands.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { buildInvalidParametersResponse } from '../../httpRoutes/validateCommands.js'
import { AdminHandler } from './adminHandler.js'

export class StopNodeHandler extends AdminHandler {
  handle(task: AdminCommand): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    if (!validation.valid) {
      return Promise.resolve(buildInvalidParametersResponse(validation))
    }
    CORE_LOGGER.logMessage(`Stopping node execution...`)
    setTimeout(() => {
      process.exit()
    }, 2000)
    return Promise.resolve({
      status: { httpStatus: 200 },
      stream: new ReadableString('EXIT OK')
    })
  }
}
