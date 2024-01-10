import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { NonceCommand } from '../../utils/constants.js'
import { getNonce } from './utils/nonceHandler.js'

export class NonceHandler extends Handler {
  isNonceCommand(obj: any): obj is NonceCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'address' in obj
  }

  async handle(task: any): Promise<P2PCommandResponse> {
    if (!this.isNonceCommand(task)) {
      throw new Error(`Task has not NonceCommand type. It has ${typeof task}`)
    }
    const { address } = task
    return getNonce(this.getP2PNode(), address)
  }
}
