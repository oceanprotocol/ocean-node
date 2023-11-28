import crypto from 'crypto'
import { DownloadCommand } from '../../utils/constants.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../@types'
import fs from 'fs'
import { P2P_CONSOLE_LOGGER } from '../P2P/index.js'
import * as ethCrypto from 'eth-crypto'
import axios from 'axios'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { getConfig } from '../../utils/config.js'
import { checkNonce, NonceResponse } from './nonceHandler.js'
import { checkProviderFees } from './checkFees.js'
import { validateOrderTransaction } from './validateTransaction.js'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

/**
 * Get the file
 * @param fileURL the location of the file
 * DO NOT export this!
 */
async function getFileFromURL(fileURL: string): Promise<any> {
  const response = await axios({
    method: 'get',
    url: fileURL,
    responseType: 'stream'
  })

  return response.data
}
// No encryption here yet
export async function handleDownloadURLCommand(
  task: DownloadCommand
): Promise<P2PCommandResponse> {
  // Validate nonce and signature
  const nonceCheckResult: NonceResponse = await checkNonce(
    task.consumerAddress,
    parseInt(task.nonce),
    task.signature
  )
  if (!nonceCheckResult.valid) {
    P2P_CONSOLE_LOGGER.logMessage(
      'Invalid nonce or signature, unable to proceed with download: ' +
        nonceCheckResult.error,
      true
    )
    throw new Error(nonceCheckResult.error)
  }

  // Call the checkProviderFees mock function to simulate fee checking
  const providerFeeResponse = checkProviderFees() // This is just a placeholder for now

  // Log the provider fee response for debugging purposes
  P2P_CONSOLE_LOGGER.logMessage(
    `Provider fee response: ${JSON.stringify(providerFeeResponse)}`,
    true
  )

  // Call the mock validateOrderTransaction function to simulate transaction validation
  const paymentValidation = validateOrderTransaction(task.transferTxId)
  if (!paymentValidation.isValid) {
    P2P_CONSOLE_LOGGER.logMessage(
      `Invalid payment transaction: ${paymentValidation.message}`,
      true
    )
    throw new Error(paymentValidation.message)
  }

  // Log the validation success for debugging purposes
  P2P_CONSOLE_LOGGER.logMessage(
    `Payment transaction validation result: ${paymentValidation.message}`,
    true
  )

  const encryptFile = !!task.aes_encrypted_key
  P2P_CONSOLE_LOGGER.logMessage(
    'DownloadCommand requires file encryption? ' + encryptFile,
    true
  )

  try {
    const inputStream = task.url.startsWith('http')
      ? await getFileFromURL(task.url) // remote url
      : fs.createReadStream(task.url) //  local file

    if (encryptFile) {
      // we parse the string into the object again
      const encryptedObject = ethCrypto.cipher.parse(task.aes_encrypted_key)
      // get the key from configuration
      const config: OceanNodeConfig = await getConfig()
      const nodePrivateKey = Buffer.from(config.keys.privateKey).toString('hex')
      const decrypted = await ethCrypto.decryptWithPrivateKey(
        nodePrivateKey,
        encryptedObject
      )
      const decryptedPayload = JSON.parse(decrypted)
      // check signature
      // const senderAddress = ethCrypto.recover(
      //  decryptedPayload.signature,
      //  ethCrypto.hash.keccak256(decryptedPayload.message)
      // )
      // Optional, we can also validate the original address of the sender (the client that created the message)
      // this could be part of the /directCommand payload for instance
      // console.log(
      //  'Got message from ' + senderAddress + ' secrets: ' + decryptedPayload.message
      // )
      const secrets = JSON.parse(decryptedPayload.message)

      const cipher = crypto
        .createCipheriv(
          FILE_ENCRYPTION_ALGORITHM,
          Buffer.from(secrets.key, 'hex'),
          Buffer.from(secrets.iv, 'hex')
        )
        .setAutoPadding(true)

      return {
        stream: inputStream.pipe(cipher),
        status: {
          httpStatus: 200,
          headers: {
            'Content-Disposition': "attachment; filename='syslog'", // TODO: the filename must come from somewhere else?
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aesgcm',
            'Transfer-Encoding': 'chunked'
          }
        }
      }
    } else {
      // Download request is not using encryption!
      return {
        stream: inputStream,
        status: {
          httpStatus: 200,
          headers: {
            'Content-Disposition': "attachment; filename='syslog'",
            'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked'
          }
        }
      }
    }
  } catch (err) {
    P2P_CONSOLE_LOGGER.logMessageWithEmoji(
      'Failure executing downloadURL task: ' + err.message,
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
