import { P2PCommandResponse } from '../../../@types/index.js'
import { EchoCommand } from '../../../@types/commands.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import {
  validateCommandParameters,
  ValidateParams
} from '../../httpRoutes/validateCommands.js'
import { Handler } from './handler.js'

export class EchoHandler extends Handler {
  validate(command: EchoCommand): ValidateParams {
    return validateCommandParameters(command, [])
  }

  async handle(task: EchoCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    return {
      status: {
        httpStatus: 200,
        error: null
      },
      stream: new ReadableString('OK')
    }
  }
}
