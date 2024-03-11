import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { StopNodeCommand } from '../../@types/commands.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ReadableString } from '../P2P/handleProtocolCommands.js'

export class StopNodeHandler extends Handler {
  handle(task: StopNodeCommand): Promise<P2PCommandResponse> {
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
