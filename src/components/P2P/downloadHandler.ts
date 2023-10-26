import crypto from 'crypto'
import { DownloadCommand } from '../../utils/constants'
import { P2PCommandResponse } from '../../@types'
import fs from 'fs'
import { P2P_CONSOLE_LOGGER, getPrivateKeyFromConfig } from '../P2P/index'
import * as ethCrypto from 'eth-crypto'
export const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'

// No encryption here yet
export async function handleDownloadURLCommand(
  task: DownloadCommand
): Promise<P2PCommandResponse> {
  let sendStream = null
  const encryptFile = !!task.aes_encrypted_key
  P2P_CONSOLE_LOGGER.logMessage(
    'DownloadCommand requires file encryption? ' + encryptFile,
    true
  )

  if (encryptFile) {
    // we parse the string into the object again
    const encryptedObject = ethCrypto.cipher.parse(task.aes_encrypted_key)
    const nodePrivateKey = await getPrivateKeyFromConfig()
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
    try {
      const inputStream = fs.createReadStream('/var/log/syslog') // will read the file/url data here

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
            'Content-Disposition': "attachment; filename='syslog'",
            'Content-Type': 'application/octet-stream'
          }
        }
      }
    } catch (err) {
      return {
        stream: null,
        status: { httpStatus: 501, error: 'Unknown error: ' + err.message }
      }
    }
  } else {
    // Download request is not using encryption!
    try {
      sendStream = fs.createReadStream('/var/log/syslog')
      // for now hardcoded file, but later will handle the urls correctly (the provider ?)
      return {
        stream: sendStream,
        status: {
          httpStatus: 200,
          headers: {
            'Content-Disposition': "attachment; filename='syslog'",
            'Content-Type': 'application/octet-stream'
          }
        }
      }
    } catch (err) {
      return {
        stream: null,
        status: { httpStatus: 501, error: 'Unknown error: ' + err.message }
      }
    }
  }
}
