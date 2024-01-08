import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { NonceCommand } from '../../utils/constants.js'
import { NonceDatabase } from '../database/index.js'
import {
  getDefaultErrorResponse,
  getDefaultResponse,
  DB_CONSOLE_LOGGER
} from './utils/nonceHandler.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { TypesenseError } from '../database/typesense.js'

export class NonceHandler extends Handler {
  isNonceCommand(obj: any): obj is NonceCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'address' in obj
  }

  async handle(task: any): Promise<P2PCommandResponse> {
    const db: NonceDatabase = this.getP2PNode().getDatabase().nonce
    if (!this.isNonceCommand(task)) {
      throw new Error(`Task has not NonceCommand type. It has ${typeof task}`)
    }
    const { address } = task
    let nonce: any
    try {
      nonce = await db.retrieve(address)
    } catch (err) {
      // did not found anything, try add it and return default
      if (err instanceof TypesenseError && err.httpStatus === 404) {
        DB_CONSOLE_LOGGER.logMessageWithEmoji(
          `Nonce not found in the db: ${err.message}. Trying to add it...`,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        let setFirst: any
        try {
          setFirst = await db.create(address, 0)
        } catch (err) {
          DB_CONSOLE_LOGGER.logMessageWithEmoji(
            `Failure adding the nonce in db: ${err.message}.`,
            true,
            GENERIC_EMOJIS.EMOJI_CROSS_MARK,
            LOG_LEVELS_STR.LEVEL_ERROR
          )
        }
        if (setFirst) {
          return getDefaultResponse(0)
        }
        return getDefaultErrorResponse(
          `Unable to retrieve nonce neither set first default for: ${address}`
        )
      }
    }
    if (nonce !== null) {
      return getDefaultResponse(nonce.nonce)
    }
  }
}
