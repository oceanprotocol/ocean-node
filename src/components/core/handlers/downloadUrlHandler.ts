import { Handler } from './handler.js'
import { OceanNodeConfig, P2PCommandResponse } from '../../../@types/OceanNode.js'
import { DownloadURLCommand } from '../../../utils/constants.js'
import crypto from 'crypto'
import { P2P_CONSOLE_LOGGER } from '../../P2P/index.js'
import * as ethCrypto from 'eth-crypto'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { Storage } from '../../storage/index.js'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

export class DownloadUrlHandler extends Handler {
  public constructor(task: any, config: OceanNodeConfig) {
    super(task, config, null)
    if (!this.isDownloadUrlCommand(task)) {
      throw new Error(`Task has not DownloadCommand type. It has ${typeof task}`)
    }
  }

  isDownloadUrlCommand(obj: any): obj is DownloadURLCommand {
    return (
      typeof obj === 'object' && obj !== null && 'command' in obj && 'fileObject' in obj
    )
  }

  // No encryption here yet
  async handle(): Promise<P2PCommandResponse> {
    const task = this.getTask()
    const config = this.getConfig()
    const encryptFile = !!task.aes_encrypted_key
    P2P_CONSOLE_LOGGER.logMessage(
      'DownloadCommand requires file encryption? ' + encryptFile,
      true
    )

    try {
      // Determine the type of storage and get a readable stream
      const storage = Storage.getStorageClass(task.fileObject)
      const inputStream = await storage.getReadableStream()
      const headers: any = {}
      for (const [key, value] of Object.entries(inputStream.headers)) {
        headers[key] = value
      }
      // need to check if content length is already in headers, but we don't know the case
      const objTemp = JSON.parse(JSON.stringify(headers).toLowerCase())
      if (!('Content-Length'.toLowerCase() in objTemp))
        headers['Transfer-Encoding'] = 'chunked'
      if (!('Content-Disposition'.toLowerCase() in objTemp))
        headers['Content-Disposition'] = 'attachment;filename=unknownfile' // TO DO: use did+serviceId+fileIndex
      if (encryptFile) {
        // we parse the string into the object again
        const encryptedObject = ethCrypto.cipher.parse(task.aes_encrypted_key)
        // get the key from configuration
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

        headers['Content-Encoding'] = 'aesgcm'

        return {
          stream: inputStream.stream.pipe(cipher),
          status: {
            httpStatus: inputStream.httpStatus,
            headers
          }
        }
      } else {
        // Download request is not using encryption!
        return {
          stream: inputStream.stream,
          status: {
            httpStatus: inputStream.httpStatus,
            headers
          }
        }
      }
    } catch (err) {
      P2P_CONSOLE_LOGGER.logMessageWithEmoji(
        'Failure executing downloadURL task: ' + err.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      return {
        stream: null,
        status: { httpStatus: 501, error: 'Unknown error: ' + err.message }
      }
    }
  }
}
