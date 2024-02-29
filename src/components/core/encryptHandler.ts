import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { EncryptCommand, EncryptFileCommand } from '../../@types/commands.js'
import * as base58 from 'base58-js'
import { Readable } from 'stream'
import { encrypt } from '../../utils/crypt.js'
import { Storage } from '../storage/index.js'
import { getConfiguration } from '../../utils/index.js'

export class EncryptHandler extends Handler {
  async handle(task: EncryptCommand): Promise<P2PCommandResponse> {
    try {
      // prepare an empty array in case if
      let blobData: Uint8Array = new Uint8Array()
      if (task.encoding === 'string') {
        // get bytes from basic blob
        blobData = Uint8Array.from(Buffer.from(task.blob))
      }
      if (task.encoding === 'base58') {
        // get bytes from a blob that is encoded in standard base58
        blobData = base58.base58_to_binary(task.blob)
      }
      // do encrypt magic
      const encryptedData = await encrypt(blobData, task.encryptionType)
      return {
        stream: Readable.from('0x' + encryptedData.toString('hex')),
        status: { httpStatus: 200 }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}

export class EncryptFileHandler extends Handler {
  async handle(task: EncryptFileCommand): Promise<P2PCommandResponse> {
    try {
      const config = await getConfiguration()
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-Encrypted-By': config.keys.peerId.toString(),
        'X-Encrypted-Method': task.encryptionType
      }
      let encryptedContent: Buffer
      if (task.files) {
        const storage = Storage.getStorageClass(task.files)
        encryptedContent = await storage.encryptContent(task.encryptionType)
      } else if (task.rawData !== null) {
        encryptedContent = await encrypt(task.rawData, task.encryptionType)
      }
      return {
        stream: Readable.from(encryptedContent),
        status: {
          httpStatus: 200,
          headers
        }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
