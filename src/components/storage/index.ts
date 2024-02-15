import {
  UrlFileObject,
  IpfsFileObject,
  ArweaveFileObject,
  StorageReadable,
  FileInfoRequest,
  FileInfoResponse
} from '../../@types/fileObject.js'
import axios from 'axios'
import urlJoin from 'url-join'
import { Readable } from 'node:stream'
import { fetchFileMetadata } from '../../utils/asset.js'
import { getConfiguration } from '../../utils/index.js'
import { decrypt } from '../../utils/crypt.js'
import { streamToString } from '../../utils/util.js'
import { INDEXER_LOGGER } from '../../utils/logging/common.js'

export abstract class Storage {
  private file: any
  public constructor(file: any) {
    this.file = file
  }

  abstract validate(): [boolean, string]

  abstract getDownloadUrl(): string
  abstract fetchSpecificFileMetadata(fileObject: any): Promise<FileInfoResponse>

  getFile(): any {
    return this.file
  }

  async processStream(stream: Readable): Promise<Readable> {
    if (!this.file?.encryptedBy || this.file?.encryptedMethod) {
      return stream
    }

    INDEXER_LOGGER.logMessage('Stream in encrypted', true)

    const streamString = await streamToString(stream as Readable)
    const { keys } = await getConfiguration()
    const nodeId = keys.peerId.toString()

    if (this.file?.encryptedBy !== nodeId) {
      throw Error(`Decrypt stream error: ${this.file?.encryptedBy} !== ${nodeId}`)
    }

    const decryptedData = decrypt(
      Uint8Array.from(Buffer.from(streamString, 'hex')),
      this.file?.encryptedMethod
    )

    return Readable.from([decryptedData])
  }

  static getStorageClass(file: any): UrlStorage | IpfsStorage | ArweaveStorage {
    const { type } = file
    switch (type) {
      case 'url':
        return new UrlStorage(file)
      case 'ipfs':
        return new IpfsStorage(file)
      case 'arweave':
        return new ArweaveStorage(file)
      default:
        throw new Error(`Invalid storage type: ${type}`)
    }
  }

  async getFileInfo(fileInfoRequest: FileInfoRequest): Promise<FileInfoResponse[]> {
    if (!fileInfoRequest.type) {
      throw new Error('Storage type is not provided')
    }

    const response: FileInfoResponse[] = []

    try {
      const file = this.getFile()

      if (!file) {
        throw new Error('Empty file object')
      } else {
        const fileInfo = await this.fetchSpecificFileMetadata(file)
        response.push(fileInfo)
      }
    } catch (error) {
      console.log(error)
    }
    return response
  }
}

export class UrlStorage extends Storage {
  public constructor(file: UrlFileObject) {
    super(file)
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the URL file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    const file: UrlFileObject = this.getFile()
    if (!file.url || !file.method) {
      return [false, 'URL or method are missing']
    }
    if (!['get', 'post'].includes(file.method.toLowerCase())) {
      return [false, 'Invalid method for URL']
    }
    if (this.isFilePath() === true) {
      return [false, 'URL looks like a file path']
    }

    return [true, '']
  }

  isFilePath(): boolean {
    const regex: RegExp = /^(.+)\/([^/]+)$/ // The URL should not represent a path
    const { url } = this.getFile()
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return false
    }

    return regex.test(url)
  }

  getDownloadUrl(): string {
    if (this.validate()[0] === true) {
      return this.getFile().url
    }
    return null
  }

  async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()
    const response = await axios({
      method: 'get',
      url: input,
      responseType: 'stream'
    })
    return {
      httpStatus: response.status,
      stream: await this.processStream(response.data),
      headers: response.headers as any
    }
  }

  async fetchSpecificFileMetadata(fileObject: UrlFileObject): Promise<FileInfoResponse> {
    const { url } = fileObject
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: new URL(url).pathname.split('/').pop() || '',
      type: 'url'
    }
  }
}

export class ArweaveStorage extends Storage {
  public constructor(file: ArweaveFileObject) {
    super(file)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the Arweave file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    if (!process.env.ARWEAVE_GATEWAY) {
      return [false, 'Arweave gateway is not provided!']
    }
    const file: ArweaveFileObject = this.getFile()
    if (!file.transactionId) {
      return [false, 'Missing transaction ID']
    }
    return [true, '']
  }

  getDownloadUrl(): string {
    return urlJoin(process.env.ARWEAVE_GATEWAY, this.getFile().transactionId)
  }

  async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()

    const response = await axios({
      method: 'get',
      url: input,
      responseType: 'stream'
    })

    return {
      httpStatus: response.status,
      stream: await this.processStream(response.data),
      headers: response.headers as any
    }
  }

  async fetchSpecificFileMetadata(
    fileObject: ArweaveFileObject
  ): Promise<FileInfoResponse> {
    const url = urlJoin(process.env.ARWEAVE_GATEWAY, fileObject.transactionId)
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: new URL(url).pathname.split('/').pop() || '',
      type: 'arweave'
    }
  }
}

export class IpfsStorage extends Storage {
  public constructor(file: IpfsFileObject) {
    super(file)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the IPFS file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    if (!process.env.IPFS_GATEWAY) {
      return [false, 'IPFS gateway is not provided!']
    }
    const file: IpfsFileObject = this.getFile()
    if (!file.hash) {
      return [false, 'Missing CID']
    }

    return [true, '']
  }

  getDownloadUrl(): string {
    return urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', this.getFile().hash))
  }

  async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()

    const response = await axios({
      method: 'get',
      url: input,
      responseType: 'stream'
    })

    return {
      httpStatus: response.status,
      stream: await this.processStream(response.data),
      headers: response.headers as any
    }
  }

  async fetchSpecificFileMetadata(fileObject: IpfsFileObject): Promise<FileInfoResponse> {
    const url = urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', fileObject.hash))
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: '',
      type: 'ipfs'
    }
  }
}
