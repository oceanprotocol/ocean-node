import { Handler } from './handler.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { EncryptCommand, EncryptFileCommand } from '../../@types/commands.js'
import * as base58 from 'base58-js'
import { Readable } from 'stream'
import { encrypt } from '../../utils/crypt.js'
import { ArweaveFileObject, IpfsFileObject, UrlFileObject } from '../../@types/fileObject'
import urlJoin from 'url-join'
import axios from 'axios'

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
      if (task.files.type === 'url') {
        const file = task.files as UrlFileObject
        const response = await axios({
          url: file.url,
          method: file.method || 'get',
          headers: file.headers
        })
        const encryptedContent = await encrypt(response.data, task.encryptionType)
        return {
          stream: Readable.from(encryptedContent),
          status: { httpStatus: 200 }
        }
      }
      if (task.files.type === 'arweave') {
        const file = task.files as ArweaveFileObject
        const response = await axios({
          url: urlJoin(process.env.ARWEAVE_GATEWAY, file.transactionId),
          method: 'get'
        })
        const encryptedContent = await encrypt(response.data, task.encryptionType)
        return {
          stream: Readable.from(encryptedContent),
          status: { httpStatus: 200 }
        }
      }
      if (task.files.type === 'ipfs') {
        const file = task.files as IpfsFileObject
        const response = await axios({
          url: file.hash,
          method: 'get'
        })
        const encryptedContent = await encrypt(response.data, task.encryptionType)
        return {
          stream: Readable.from(encryptedContent),
          status: { httpStatus: 200 }
        }
      }
      return {
        stream: null,
        status: { httpStatus: 400, error: 'Unknown file type' }
      }
    } catch (error) {
      return {
        stream: null,
        status: { httpStatus: 500, error: 'Unknown error: ' + error.message }
      }
    }
  }
}
