import {
  ArweaveFileObject,
  FileInfoResponse,
  StorageReadable
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { fetchFileMetadata } from '../../utils/asset.js'
import urlJoin from 'url-join'
import axios from 'axios'
import { Storage } from './Storage.js'

export class ArweaveStorage extends Storage {
  public constructor(file: ArweaveFileObject, config: OceanNodeConfig) {
    super(file, config)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validating the Arweave file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    if (!this.config.arweaveGateway) {
      return [false, 'Arweave gateway is not configured!']
    }
    const file: ArweaveFileObject = this.getFile() as ArweaveFileObject
    if (!file.transactionId) {
      return [false, 'Missing transaction ID']
    }
    if (
      file.transactionId.startsWith('http://') ||
      file.transactionId.startsWith('https://')
    ) {
      return [
        false,
        'Transaction ID looks like an URL. Please specify URL storage instead.'
      ]
    }
    if (this.isFilePath() === true) {
      return [false, 'Transaction ID looks like a file path']
    }
    return [true, '']
  }

  isFilePath(): boolean {
    const regex: RegExp = /^(.+)\/([^/]*)$/ // The transaction ID should not represent a path
    const { transactionId } = this.getFile()

    return regex.test(transactionId)
  }

  getDownloadUrl(): string {
    return urlJoin(this.config.arweaveGateway, this.getFile().transactionId)
  }

  override async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()
    const response = await axios({
      method: 'get',
      url: input,
      responseType: 'stream',
      timeout: 30000
    })

    return {
      httpStatus: response.status,
      stream: response.data,
      headers: response.headers as any
    }
  }

  async fetchSpecificFileMetadata(
    fileObject: ArweaveFileObject,
    forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const url = urlJoin(this.config.arweaveGateway, fileObject.transactionId)
    const { contentLength, contentType, contentChecksum } = await fetchFileMetadata(
      url,
      'get',
      forceChecksum
    )
    return {
      valid: true,
      contentLength,
      contentType,
      checksum: contentChecksum,
      name: '', // Never send the file name for Arweave as it may leak the transaction ID
      type: 'arweave',
      encryptedBy: fileObject.encryptedBy,
      encryptMethod: fileObject.encryptMethod
    }
  }
}
