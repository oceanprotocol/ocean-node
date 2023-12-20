import { P2PCommandResponse } from '../../../@types/index.js'

import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../../utils/logging/Logger.js'
import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { OceanP2P } from '../../P2P/index.js'
import { Database, NonceDatabase } from '../../database/index.js'
import { ethers } from 'ethers'
import { Handler } from './aHandler.js'
import { NonceCommand } from '../../../utils/constants.js'

export const DB_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)
function getDefaultErrorResponse(errorMessage: string): P2PCommandResponse {
  return {
    stream: null,
    status: { httpStatus: 501, error: 'Unknown error: ' + errorMessage }
  }
}

function getDefaultResponse(nonce: number): P2PCommandResponse {
  const streamResponse = new ReadableString(String(nonce))
  // set nonce here
  return {
    status: {
      httpStatus: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    },
    stream: streamResponse
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

// returns true/false (+ error message if needed)
export type NonceResponse = {
  valid: boolean
  error?: string
}

// get stored nonce for an address ( 0 if not found)
export async function getNonce(
  node: OceanP2P,
  address: string
): Promise<P2PCommandResponse> {
  // get nonce from db
  const db: NonceDatabase = node.getDatabase().nonce
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

// update stored nonce for an address
async function updateNonce(
  db: NonceDatabase,
  address: string,
  nonce: number
): Promise<NonceResponse> {
  try {
    // update nonce on db
    // it will create if none exists yet
    const resp = await db.update(address, nonce)
    return {
      valid: resp != null,
      error: resp == null ? 'error updating nonce to: ' + nonce : null
    }
  } catch (err) {
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      'Failure executing nonce task: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return {
      valid: false,
      error: err.message
    }
  }
}

// get stored nonce for an address, update it on db, validate signature
export async function checkNonce(
  node: OceanP2P,
  consumer: string,
  nonce: number,
  signature: string,
  ddoId: string = null
): Promise<NonceResponse> {
  try {
    // get nonce from db
    const db: NonceDatabase = node.getDatabase().nonce
    let previousNonce = 0 // if none exists
    const existingNonce = await db.retrieve(consumer)
    if (existingNonce !== null) {
      previousNonce = existingNonce.nonce
    }
    // check if bigger than previous stored one and validate signature
    const validate = validateNonceAndSignature(
      nonce,
      previousNonce, // will return 0 if none exists
      consumer,
      signature,
      ddoId
    )
    if (validate.valid) {
      const updateStatus = await updateNonce(db, consumer, nonce)
      return updateStatus
    }
    return validate
    // return validation status and possible error msg
  } catch (err) {
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      'Failure executing nonce task: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEL_ERROR
    )
    return {
      valid: false,
      error: err.message
    }
  }
}

/**
 *
 * @param nonce nonce
 * @param existingNonce store nonce
 * @param consumer address
 * @param signature sign(nonce)
 * @returns true or false + error message
 */
function validateNonceAndSignature(
  nonce: number,
  existingNonce: number,
  consumer: string,
  signature: string,
  ddoId: string = null
): NonceResponse {
  // check if is bigger than previous nonce
  if (nonce > existingNonce) {
    // nonce good
    // now validate signature
    let message: string
    if (ddoId) message = String(ddoId + nonce)
    else message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const recoveredAddress = ethers.verifyMessage(messageHashBytes, signature)
    if (ethers.getAddress(recoveredAddress) === ethers.getAddress(consumer)) {
      // update nonce on DB, return OK
      return {
        valid: true
      }
    }
    return {
      valid: false,
      error: 'consumer address and nonce signature mismatch'
    }
  }
  return {
    valid: false,
    error: 'nonce: ' + nonce + ' is not a valid nonce'
  }
}
