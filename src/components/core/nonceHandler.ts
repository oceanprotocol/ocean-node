import { Stream } from 'node:stream'
import { P2PCommandResponse } from '../../@types/index.js'

import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'
import { ReadableString } from '../P2P/handleProtocolCommands.js'
import { Database } from '../database/index.js'

export const DB_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

const db = new Database(null)

// get stored nonce for an address ( 0 if not found)
export async function getNonce(address: string): Promise<P2PCommandResponse> {
  try {
    // get nonce from db
    const nonce = await db.getNonce(address)
    console.log(`Got DB Nonce: ${nonce})`)
    const streamResponse = new ReadableString(String(nonce))
    console.log('Getting nonce from: ', address)
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
  } catch (err) {
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      'Failure executing nonce task: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return {
      stream: null,
      status: { httpStatus: 501, error: 'Unknown error: ' + err.message }
    }
  }
}

// update stored nonce for an address
export async function updateNonce(address: string, nonce: number): Promise<boolean> {
  console.log('updateNonce, nonce: ' + nonce, 'address: ' + address)
  let res = false
  try {
    // update nonce on db
    const nonce = '0' // await db.updateNonce(address, nonce)
    res = true
  } catch (err) {
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      'Failure executing nonce task: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
  }
  return res
}

// get stored nonce for an address, update it on db, validate
export async function checkNonce(
  consumer: string,
  nonce: number,
  signature: string
): Promise<P2PCommandResponse> {
  console.log(
    'checkNonce, consumer: ' + consumer,
    'nonce: ' + nonce,
    'signature: ' + signature
  )
  try {
    // get nonce from db
    const streamResponse = new Stream.Readable()
    // set nonce here
    streamResponse.push(0)
    return {
      status: {
        httpStatus: 200,
        headers: {
          'Content-Type': 'text/plain'
        }
      },
      stream: streamResponse
    }
  } catch (err) {
    DB_CONSOLE_LOGGER.logMessageWithEmoji(
      'Failure executing nonce task: ' + err.message,
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return {
      stream: null,
      status: { httpStatus: 501, error: 'Unknown error: ' + err.message }
    }
  }
}
