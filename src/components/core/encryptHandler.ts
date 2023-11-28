import { EncryptCommand } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types'
import { Readable } from 'stream'
import * as base58 from 'base58-js'
import { encrypt } from '../../utils/crypt.js'

export async function handleEncryptCommand(
  task: EncryptCommand
): Promise<P2PCommandResponse> {
  try {
    let blobData: Uint8Array = new Uint8Array()
    if (task.encoding === 'string') {
      blobData = Uint8Array.from(Buffer.from(task.blob))
    }
    if (task.encoding === 'base58') {
      blobData = base58.base58_to_binary(task.blob)
    }
    const encryptedData = await encrypt(blobData, task.encryptionType)
    return {
      stream: Readable.from(encryptedData.toString()),
      status: { httpStatus: 200 }
    }
  } catch (error) {
    return {
      stream: null,
      status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
    }
  }
}
