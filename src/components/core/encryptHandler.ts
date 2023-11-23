import { EncryptCommand } from '../../utils/constants'
import { P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import * as base58 from 'base58-js'
import crypto from 'crypto'

export async function handleEncryptCommand(
  task: EncryptCommand
): Promise<P2PCommandResponse> {
  try {
    let blobData: Uint8Array = new Uint8Array()
    if (task.encoding === 'String') {
      blobData = Uint8Array.from(Buffer.from(task.blob, 'hex'))
    }
    if (task.encoding === 'Base58') {
      blobData = base58.base58_to_binary(task.blob)
    }

    let encryptedData: Buffer
    if (task.encryptionType === 'AES') {
      const algorithm = 'aes-256-cbc'
      const initVector = crypto.randomBytes(16)
      const securityKey = crypto.randomBytes(32)
      const cipher = crypto.createCipheriv(algorithm, securityKey, initVector)
      encryptedData = Buffer.concat([cipher.update(blobData), cipher.final()])
    }
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
