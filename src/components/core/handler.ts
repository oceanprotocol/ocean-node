import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { OceanP2P } from '../P2P/index.js'

export abstract class Handler {
  private p2pNode: OceanP2P
  public constructor(p2pNode: OceanP2P) {
    this.p2pNode = p2pNode
  }

  abstract handle(task: any): Promise<P2PCommandResponse>

  getP2PNode(): OceanP2P | null {
    if (!this.p2pNode) {
      return null
    }
    return this.p2pNode
  }
}
