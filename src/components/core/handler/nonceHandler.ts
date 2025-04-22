import { CommandHandler } from './handler.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { NonceCommand } from '../../../@types/commands.js'
import { getNonce } from '../utils/nonceHandler.js'
import {
  ValidateParams,
  buildInvalidRequestMessage,
  validateCommandParameters
} from '../../httpRoutes/validateCommands.js'
import { isAddress } from 'ethers'

export class NonceHandler extends CommandHandler {
  validate(command: NonceCommand): ValidateParams {
    const validation = validateCommandParameters(command, ['address'])
    if (validation.valid) {
      if (!isAddress(command.address)) {
        return buildInvalidRequestMessage(
          'Parameter : "address" is not a valid web3 address'
        )
      }
    }
    return validation
  }

  // eslint-disable-next-line require-await
  async handle(task: NonceCommand): Promise<P2PCommandResponse> {
    const validationResponse = await this.verifyParamsAndRateLimits(task)
    if (this.shouldDenyTaskHandling(validationResponse)) {
      return validationResponse
    }
    const { address } = task
    return getNonce(this.getOceanNode().getDatabase().nonce, address)
  }
}
