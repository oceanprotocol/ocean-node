import { Database, NonceDatabase } from '../../database/index.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { OceanP2P } from '../../P2P/index.js'
import { NonceCommand } from '../../../utils/constants.js'
import {
  DB_CONSOLE_LOGGER,
  getDefaultResponse,
  getDefaultErrorResponse
} from './utils/nonceHandler.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'

export abstract class Handler {
  private config: OceanNodeConfig
  // Put database separately because of async constructor
  // that Database class has
  private db: Database
  private task: any
  private p2pNode: OceanP2P
  public constructor(task: any, config?: OceanNodeConfig, db?: Database) {
    this.config = config
    this.db = db
    this.task = task
    if (this.config && this.db) {
      this.p2pNode = new OceanP2P(this.db, this.config)
    }
  }

  abstract handle(): Promise<P2PCommandResponse>
  getDatabase(): Database | null {
    if (!this.db) {
      return null
    }
    return this.db
  }

  getTask(): any {
    return this.task
  }

  getConfig(): OceanNodeConfig | null {
    if (!this.config) {
      return null
    }
    return this.config
  }

  getP2PNode(): OceanP2P | null {
    if (!this.p2pNode) {
      return null
    }
    return this.p2pNode
  }

  setTask(task: any): void {
    this.task = task
  }
}

export class NonceHandler extends Handler {
  public constructor(task: any, db: Database) {
    super(task, null, db)
    if (!this.isNonceCommand(task)) {
      throw new Error(`Task has not GetFeesCommand type. It has ${typeof task}`)
    }
  }

  isNonceCommand(obj: any): obj is NonceCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'address' in obj
  }

  async handle(): Promise<P2PCommandResponse> {
    const db: NonceDatabase = this.getDatabase().nonce
    const { address } = this.getTask()
    try {
      const nonce = await db.retrieve(address)
      if (nonce !== null) {
        return getDefaultResponse(nonce.nonce)
      }
      // // did not found anything, try add it and return default
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
