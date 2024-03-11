import { ReadableString } from '../../P2P/handleProtocolCommands.js'
import { P2PCommandResponse } from '../../../@types/OceanNode.js'
import { ethers } from 'ethers'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { NonceDatabase } from '../../database/index.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'

export function getDefaultErrorResponse(errorMessage: string): P2PCommandResponse {
  return {
    stream: null,
    status: { httpStatus: 501, error: 'Unknown error: ' + errorMessage }
  }
}

export function getDefaultResponse(nonce: number): P2PCommandResponse {
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

// returns true/false (+ error message if needed)
export type NonceResponse = {
  valid: boolean
  error?: string
}

// get stored nonce for an address ( 0 if not found)
export async function getNonce(
  db: NonceDatabase,
  address: string
): Promise<P2PCommandResponse> {
  // get nonce from db
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
      DATABASE_LOGGER.logMessageWithEmoji(
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
    DATABASE_LOGGER.logMessageWithEmoji(
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
  db: NonceDatabase,
  consumer: string,
  nonce: number,
  signature: string,
  ddoId: string = null
): Promise<NonceResponse> {
  try {
    // get nonce from db
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
      String(ddoId + nonce)
    )
    if (validate.valid) {
      const updateStatus = await updateNonce(db, consumer, nonce)
      return updateStatus
    }
    return validate
    // return validation status and possible error msg
  } catch (err) {
    DATABASE_LOGGER.logMessageWithEmoji(
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
 * @param message Use this message instead of default String(nonce)
 * @returns true or false + error message
 */
function validateNonceAndSignature(
  nonce: number,
  existingNonce: number,
  consumer: string,
  signature: string,
  message: string = null
): NonceResponse {
  // check if is bigger than previous nonce
  if (nonce > existingNonce) {
    // nonce good
    // now validate signature
    if (!message) message = String(nonce)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    const addressFromHashSignature = ethers.verifyMessage(consumerMessage, signature)
    const addressFromBytesSignature = ethers.verifyMessage(messageHashBytes, signature)

    if (
      ethers.getAddress(addressFromHashSignature) === ethers.getAddress(consumer) ||
      ethers.getAddress(addressFromBytesSignature) === ethers.getAddress(consumer)
    ) {
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

export async function sign(message: string, privateKey: string): Promise<string> {
  /** Signs a message with a private key
   *
   * @param message - message to be sign
   * @param privateKey - private key from node as Uint8Array
   */
  const wallet = new ethers.Wallet('0x' + Buffer.from(privateKey).toString('hex'))
  // message to sign
  // sign message/nonce
  const consumerMessage = ethers.solidityPackedKeccak256(
    ['bytes'],
    [ethers.hexlify(ethers.toUtf8Bytes(message))]
  )
  const messageHashBytes = ethers.toBeArray(consumerMessage)
  const signature = await wallet.signMessage(messageHashBytes)
  return signature
}
