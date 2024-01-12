import {
  UrlFileObject,
  IpfsFileObject,
  ArweaveFileObject,
  StorageReadable,
  FileInfoRequest
} from '../../@types/fileObject.js'
import axios from 'axios'
import urlJoin from 'url-join'

async function fetchFileMetadata(
  url: string
): Promise<{ contentLength: string; contentType: string }> {
  let contentLength: string = ''
  let contentType: string = ''
  try {
    // First try with HEAD request
    const response = await axios.head(url)

    contentLength = response.headers['content-length']
    contentType = response.headers['content-type']
  } catch (error) {
    // Fallback to GET request
    const response = await axios.get(url, { method: 'GET', responseType: 'stream' })

    contentLength = response.headers['content-length']
    contentType = response.headers['content-type']
  }

  if (!contentLength) {
    try {
      const response = await axios.get(url, { responseType: 'stream' })
      let totalSize = 0

      for await (const chunk of response.data) {
        totalSize += chunk.length
      }
      contentLength = totalSize.toString()
    } catch (error) {
      console.error('Error downloading file:', error)
      contentLength = 'Unknown'
    }
  }
  return {
    contentLength,
    contentType
  }
}

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

    try {
      const { url } = fileInfoRequest
      const { contentLength, contentType } = await fetchFileMetadata(url)

      return {
        valid: true,
        contentLength,
        contentType,
        name: new URL(url).pathname.split('/').pop() || '',
        type: 'url'
        // Add checksum logic if required
      }
    } catch (error) {
      console.log(error)
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

    try {
      const url = urlJoin(process.env.ARWEAVE_GATEWAY, fileInfoRequest.transactionId)

      const { contentLength, contentType } = await fetchFileMetadata(url)

      return {
        valid: true,
        contentLength: contentLength || 'Unknown',
        contentType,
        name: '',
        type: 'arweave'
        // Add checksum logic
      }
    } catch (error) {
      // Handle errors (e.g., file not accessible)
      console.log(error)
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

    try {
      const url = urlJoin(
        process.env.IPFS_GATEWAY,
        urlJoin('/ipfs', fileInfoRequest.hash)
      )

      const { contentLength, contentType } = await fetchFileMetadata(url)

      return {
        valid: true,
        contentLength,
        contentType,
        name: '',
        type: 'ipfs'
        // Add checksum logic
      }
    } catch (error) {
      // Handle errors (e.g., file not accessible)
    }
  }
}
