import { P2PCommandResponse } from '../../@types'
import { Command } from '../../@types/commands.js'
import { ReadableString } from '../P2P/handleProtocolCommands.js'
import { Handler } from './handler.js'

export class EchoHandler extends Handler {
  handle(task: Command): Promise<P2PCommandResponse> {
    return new Promise<P2PCommandResponse>((resolve, reject) => {
      resolve({
        status: { httpStatus: 200 },
        stream: new ReadableString('OK')
      })
    })
  }
}
