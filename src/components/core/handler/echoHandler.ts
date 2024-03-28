import { P2PCommandResponse } from '../../../@types/index.js'
import { EchoCommand } from '../../../@types/commands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import {
  buildRateLimitReachedResponse,
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { Handler } from './handler.js'

export class EchoHandler extends Handler {
  validate(command: EchoCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: EchoCommand): Promise<P2PCommandResponse> {
    if (!(await this.checkRateLimit())) {
      return buildRateLimitReachedResponse()
    }
    const validation = this.validate(task)
    return {
      status: {
        httpStatus: validation.valid ? 200 : validation.status,
        error: validation.valid ? '' : validation.reason
      },
      stream: validation.valid ? new ReadableString('OK') : null
    }
  }
}
