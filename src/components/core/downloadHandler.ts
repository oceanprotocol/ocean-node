import crypto from 'crypto'
import { DownloadCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import fs from 'fs'
import { OceanP2P, P2P_CONSOLE_LOGGER } from '../P2P/index.js'
import * as ethCrypto from 'eth-crypto'
import axios from 'axios'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
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
  node: OceanP2P,
  task: DownloadCommand
): Promise<P2PCommandResponse> {
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
      const nodePrivateKey = Buffer.from(node.getConfig().keys.privateKey).toString('hex')
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
