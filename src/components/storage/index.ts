import {
  UrlFileObject,
  IpfsFileObject,
  ArweaveFileObject,
  StorageReadable,
  FileInfoRequest
} from '../../@types/fileObject.js'
import axios from 'axios'
import urlJoin from 'url-join'

export abstract class Storage {
  private file: any
  public constructor(file: any) {
    this.file = file
  }

  abstract validate(): [boolean, string]

  abstract getDownloadUrl(): string

  abstract getFileInfo(fileInfoRequest: FileInfoRequest): Promise<any>

  getFile(): any {
    return this.file
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
      stream: response.data,
      headers: response.headers as any
    }
  }

  async getFileInfo(fileInfoRequest: FileInfoRequest): Promise<any> {
    if (!fileInfoRequest.type && !fileInfoRequest.did) {
      throw new Error('Either type or did must be provided')
    }
    if (!fileInfoRequest.type && !fileInfoRequest.serviceId) {
      throw new Error('serviceId is required when type is not provided')
    }
    if (fileInfoRequest.type === 'url' && !fileInfoRequest.url) {
      throw new Error('URL is required for type url')
    }

    const file = this.getFile()

    // Initial file info structure
    const fileInfo = {
      valid: false,
      contentLength: '',
      contentType: '',
      name: file.name || '',
      type: file.type,
      checksumType: '',
      checksum: ''
    }

    try {
      // get file info...
    } catch (error) {
      // Handle errors (e.g., file not accessible)
    }

    return fileInfo
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
      stream: response.data,
      headers: response.headers as any
    }
  }

  async getFileInfo(fileInfoRequest: FileInfoRequest): Promise<any> {
    if (!fileInfoRequest.type && !fileInfoRequest.did) {
      throw new Error('Either type or did must be provided')
    }
    if (!fileInfoRequest.type && !fileInfoRequest.serviceId) {
      throw new Error('serviceId is required when type is not provided')
    }
    if (fileInfoRequest.type === 'arweave' && !fileInfoRequest.transactionId) {
      throw new Error('Transaction ID is required for type arweave')
    }

    const file = this.getFile()

    // Initial file info structure
    const fileInfo = {
      valid: false,
      contentLength: '',
      contentType: '',
      name: file.name || '',
      type: file.type,
      checksumType: '',
      checksum: ''
    }

    try {
      // get file info...
    } catch (error) {
      // Handle errors (e.g., file not accessible)
    }

    return fileInfo
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
      stream: response.data,
      headers: response.headers as any
    }
  }

  async getFileInfo(fileInfoRequest: FileInfoRequest): Promise<any> {
    if (!fileInfoRequest.type && !fileInfoRequest.did) {
      throw new Error('Either type or did must be provided')
    }
    if (!fileInfoRequest.type && !fileInfoRequest.serviceId) {
      throw new Error('serviceId is required when type is not provided')
    }
    if (fileInfoRequest.type === 'ipfs' && !fileInfoRequest.hash) {
      throw new Error('Hash is required for type ipfs')
    }

    const file = this.getFile()

    // Initial file info structure
    const fileInfo = {
      valid: false,
      contentLength: '',
      contentType: '',
      name: file.name || '',
      type: file.type,
      checksumType: '',
      checksum: ''
    }

    try {
      // get file info...
    } catch (error) {
      // Handle errors (e.g., file not accessible)
    }

    return fileInfo
  }
}
