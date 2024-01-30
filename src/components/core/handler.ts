import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { OceanNode } from '../../OceanNode.js'
import { Command, ICommandHandler } from '../../@types/commands.js'

export abstract class Handler implements ICommandHandler {
  private nodeInstance?: OceanNode
  public constructor(oceanNode?: OceanNode) {
    this.nodeInstance = oceanNode
  }

  abstract handle(task: Command): Promise<P2PCommandResponse>

  getOceanNode(): OceanNode {
    return this.nodeInstance
  }
}
