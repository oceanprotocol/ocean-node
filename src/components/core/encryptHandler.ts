import { EncryptCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import * as base58 from 'base58-js'
import { encrypt, PrivateKey, PublicKey } from 'eciesjs'
import crypto from 'crypto'
import { getConfig } from '../../utils/config.js'

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
    const config = await getConfig()
    const { privateKey } = config.keys
    const { publicKey } = config.keys
    if (task.encryptionType === 'AES') {
      const initVector = publicKey.subarray(0, 16)
      const cipher = crypto.createCipheriv('aes-256-cbc', privateKey, initVector)
      encryptedData = Buffer.concat([cipher.update(blobData), cipher.final()])
    }
    if (task.encryptionType === 'ECIES') {
      const sk = new PrivateKey(privateKey)
      encryptedData = encrypt(sk.publicKey.toHex(), blobData)
    }

    return {
      stream: Readable.from(encryptedData.toString('hex')),
      status: { httpStatus: 200 }
    }
  } catch (error) {
    console.log(error)
    return {
      stream: null,
      status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
    }
  }
}
