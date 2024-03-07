import { P2PCommandResponse } from '../../@types'
import { Command } from '../../@types/commands.js'
import { ReadableString } from '../P2P/handleProtocolCommands.js'
import {
  validateCommandParameters,
  ValidateParams
} from '../httpRoutes/validateCommands.js'
import { Handler } from './handler.js'

export class EchoHandler extends Handler {
  validate(command: Command): ValidateParams {
    return validateCommandParameters(command, [])
  }

  handle(task: Command): Promise<P2PCommandResponse> {
    const validation = this.validate(task)
    return new Promise<P2PCommandResponse>((resolve, reject) => {
      resolve({
        status: {
          httpStatus: validation.valid ? 200 : validation.status,
          error: validation.valid ? '' : validation.reason
        },
        stream: validation.valid ? new ReadableString('OK') : null
      })
    })
  }
}
