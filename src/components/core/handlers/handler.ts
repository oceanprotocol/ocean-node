import { Database, NonceDatabase } from '../../database/index.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { OceanP2P } from '../../P2P/index.js'
import {
  NonceCommand,
  GetFeesCommand,
  Command,
  EncryptCommand,
  QueryCommand
} from '../../../utils/constants.js'
import {
  DB_CONSOLE_LOGGER,
  getDefaultResponse,
  getDefaultErrorResponse
} from './utils/nonceHandler.js'
import { Readable } from 'stream'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { logger, calculateFee } from './utils/feesHandler.js'
import { status } from './utils/statusHandler.js'
import * as base58 from 'base58-js'
import { encrypt } from '../../../utils/crypt.js'

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

export class FeesHandler extends Handler {
  public constructor(task: any) {
    super(task, null, null)
    if (!this.isGetFeesCommand(task)) {
      throw new Error(`Task has not GetFeesCommand type. It has ${typeof task}`)
    }
  }

  isGetFeesCommand(obj: any): obj is GetFeesCommand {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'command' in obj &&
      'ddo' in obj &&
      'serviceId' in obj
    )
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      const task = this.getTask() as GetFeesCommand
      logger.logMessage(
        `Try to calculate fees for DDO with id: ${task.ddo.id} and serviceId: ${task.serviceId}`,
        true
      )

      const fees = await calculateFee(task.ddo, task.serviceId)
      if (fees) {
        return {
          stream: Readable.from(JSON.stringify(fees, null, 4)),
          status: { httpStatus: 200 }
        }
      } else {
        const error = `Unable to calculate fees (null) for DDO with id: ${task.ddo.id} and serviceId: ${task.serviceId}`
        logger.logMessageWithEmoji(
          error,
          true,
          GENERIC_EMOJIS.EMOJI_CROSS_MARK,
          LOG_LEVELS_STR.LEVEL_ERROR
        )
        return {
          stream: null,
          status: {
            httpStatus: 500,
            error
          }
        }
      }
    } catch (error) {
      logger.logMessageWithEmoji(
        error.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
  }
}

export class StatusHandler extends Handler {
  public constructor(task: any, config: OceanNodeConfig) {
    super(task, config, null)
    if (!this.isCommand(task)) {
      throw new Error(`Task has not Command type. It has ${typeof task}`)
    }
  }

  isCommand(obj: any): obj is Command {
    return typeof obj === 'object' && obj !== null && 'command' in obj
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      const statusResult = await status(this.getConfig(), this.getTask().node)
      if (!statusResult) {
        return {
          stream: null,
          status: { httpStatus: 404, error: 'Status Not Found' }
        }
      }
      return {
        stream: Readable.from(JSON.stringify(statusResult)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class EncryptHandler extends Handler {
  public constructor(task: any) {
    super(task, null, null)
    if (!this.isEncryptCommand(task)) {
      throw new Error(`Task has not EncryptCommand type. It has ${typeof task}`)
    }
  }

  isEncryptCommand(obj: any): obj is EncryptCommand {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      'command' in obj &&
      'blob' in obj &&
      'encoding' in obj &&
      'encryptionType' in obj
    )
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      // prepare an empty array in case if
      let blobData: Uint8Array = new Uint8Array()
      if (this.getTask().encoding === 'string') {
        // get bytes from basic blob
        blobData = Uint8Array.from(Buffer.from(this.getTask().blob))
      }
      if (this.getTask().encoding === 'base58') {
        // get bytes from a blob that is encoded in standard base58
        blobData = base58.base58_to_binary(this.getTask().blob)
      }
      // do encrypt magic
      const encryptedData = await encrypt(blobData, this.getTask().encryptionType)
      return {
        stream: Readable.from(encryptedData.toString('hex')),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class QueryHandler extends Handler {
  public constructor(task: any, database: Database) {
    super(task, null, database)
    if (!this.isQueryCommand(task)) {
      throw new Error(`Task has not QueryCommand type. It has ${typeof task}`)
    }
  }

  isQueryCommand(obj: any): obj is QueryCommand {
    return typeof obj === 'object' && obj !== null && 'command' in obj && 'query' in obj
  }

  async handle(): Promise<P2PCommandResponse> {
    try {
      let result = await this.getDatabase().ddo.search(this.getTask().query)
      if (!result) {
        result = []
      }
      return {
        stream: Readable.from(JSON.stringify(result)),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
