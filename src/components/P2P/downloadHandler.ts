import crypto from 'crypto'
import { DownloadCommand } from '../../utils/constants'
import { P2PCommandResponse } from '../../@types'

import fs from 'fs'

import { P2P_CONSOLE_LOGGER } from '../P2P/index'

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
