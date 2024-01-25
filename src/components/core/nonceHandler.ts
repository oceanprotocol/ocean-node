import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { NonceCommand } from '../../utils/constants.js'
import { getNonce } from './utils/nonceHandler.js'

export class NonceHandler extends Handler {
  async handle(task: NonceCommand): Promise<P2PCommandResponse> {
    const { address } = task
    return getNonce(this.getOceanNode().getDatabase().nonce, address)
  }
}
