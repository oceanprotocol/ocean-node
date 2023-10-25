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
    console.log('Encrypted AES secrets: ', task.aes_encrypted_key)
    // we parse the string into the object again
    const encryptedObject = ethCrypto.cipher.parse(task.aes_encrypted_key)
    const nodePrivateKey = await getPrivateKeyFromConfig()
    const decrypted = await ethCrypto.decryptWithPrivateKey(
      nodePrivateKey,
      encryptedObject
    )
    const decryptedPayload = JSON.parse(decrypted)
    // check signature
    const senderAddress = ethCrypto.recover(
      decryptedPayload.signature,
      ethCrypto.hash.keccak256(decryptedPayload.message)
    )
    // Optional, we can also validate the original address of the sender (the client that created the message)
    // this could be part of the /directCommand payload for instance
    console.log(
      'Got message from ' + senderAddress + ' secrets: ' + decryptedPayload.message
    )
  }
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

// symmetric encription of file
type SymmetricEncryptionSecrets = {
  private_key: string
  initialization_vector: string
}

// assymmetric encryption/decryption of symmetric key
type AsymmetricEncryptionSecrets = {
  private_key: string
  public_key: string
}

/**
 * Encrypt a file stream
 * @param inputStream
 * @param outputStream
 * @returns
 */
async function encryptFileStream(inputStream: any, outputStream: any): Promise<boolean> {
  // TODO
  const privateKey: string = ''
  const initVect: string = ''
  const cipher = crypto
    .createCipheriv(
      FILE_ENCRYPTION_ALGORITHM,
      Buffer.from(privateKey, 'hex'),
      Buffer.from(initVect, 'hex')
    )
    .setAutoPadding(true)

  // Details on what is going on
  cipher.on('data', (chunk) => {
    console.log('Encrypting a file chunk of size ', chunk.length)
  })

  return new Promise((resolve, reject) => {
    // Tinput => encryption => output
    inputStream.pipe(cipher).pipe(outputStream)

    inputStream.on('end', () => {
      resolve(true)
    })

    inputStream.on('error', (err: any) => {
      reject(err)
    })
  })
}
