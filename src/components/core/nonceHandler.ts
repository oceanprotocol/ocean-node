import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { NonceCommand } from '../../utils/constants.js'
import { NonceDatabase } from '../database/index.js'
import { getDefaultErrorResponse, getDefaultResponse } from './utils/nonceHandler.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { DB_CONSOLE_LOGGER } from '../../utils/logging/common.js'

export class NonceHandler extends Handler {
  async handle(task: NonceCommand): Promise<P2PCommandResponse> {
    const db: NonceDatabase = this.getP2PNode().getDatabase().nonce

    const { address } = task
    try {
      const nonce = await db.retrieve(address)
      if (nonce !== null) {
        return getDefaultResponse(nonce.nonce)
      }
      // did not found anything, try add it and return default
      const setFirst = await db.create(address, 0)
      if (setFirst) {
        return getDefaultResponse(0)
      }
      return getDefaultErrorResponse(
        `Unable to retrieve nonce neither set first default for: ${address}`
      )
    } catch (err) {
      // did not found anything, try add it and return default
      if (err.message.indexOf(address) > -1) {
        return getDefaultErrorResponse(err.message)
      } else {
        DB_CONSOLE_LOGGER.logMessageWithEmoji(
          'Failure executing nonce task: ' + err.message,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return getDefaultErrorResponse(err.message)
      }
    }
  }
}
