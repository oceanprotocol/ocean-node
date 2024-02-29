import {
  ArweaveFileObject,
  FileInfoRequest,
  FileInfoResponse,
  FileObjectType,
  IpfsFileObject,
  StorageReadable,
  UrlFileObject,
  EncryptMethod
} from '../../@types/fileObject.js'
import { fetchFileMetadata } from '../../utils/asset.js'
import axios from 'axios'
import urlJoin from 'url-join'
import { encrypt as encryptData, decrypt as decryptData } from '../../utils/crypt.js'
import { Readable } from 'stream'
import { getConfiguration } from '../../utils/index.js'

export abstract class Storage {
  private file: UrlFileObject | IpfsFileObject | ArweaveFileObject

  public constructor(file: UrlFileObject | IpfsFileObject | ArweaveFileObject) {
    this.file = file
  }

  abstract validate(): [boolean, string]
  abstract getDownloadUrl(): string
  abstract fetchSpecificFileMetadata(fileObject: any): Promise<FileInfoResponse>
  abstract encryptContent(encryptionType: 'AES' | 'ECIES'): Promise<Buffer>

  getFile(): any {
    return this.file
  }

  // similar to all subclasses
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

  static getStorageClass(file: any): UrlStorage | IpfsStorage | ArweaveStorage {
    const { type } = file
    switch (
      type.toLowerCase() // case insensitive
    ) {
      case FileObjectType.URL:
        return new UrlStorage(file)
      case FileObjectType.IPFS:
        return new IpfsStorage(file)
      case FileObjectType.ARWEAVE:
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

  async encrypt(encryptionType: EncryptMethod = EncryptMethod.AES) {
    const readableStream = await this.getReadableStream()

    // Convert the readable stream to a buffer
    const chunks: Buffer[] = []
    for await (const chunk of readableStream.stream) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)

    // Encrypt the buffer using the encrypt function
    const encryptedBuffer = await encryptData(new Uint8Array(buffer), encryptionType)

    // Convert the encrypted buffer back into a stream
    const encryptedStream = Readable.from(encryptedBuffer)

    return {
      ...readableStream,
      stream: encryptedStream
    }
  }

  async decrypt() {
    const { keys } = await getConfiguration()
    const nodeId = keys.peerId.toString()

    if (!this.canDecrypt(nodeId)) {
      throw new Error('Node is not authorized to decrypt this file')
    }

    const { encryptMethod } = this.file
    const readableStream = await this.getReadableStream()

    // Convert the readable stream to a buffer
    const chunks: Buffer[] = []
    for await (const chunk of readableStream.stream) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)

    // Decrypt the buffer using your existing function
    const decryptedBuffer = await decryptData(new Uint8Array(buffer), encryptMethod)

    // Convert the decrypted buffer back into a stream
    const decryptedStream = Readable.from(decryptedBuffer)

    return {
      ...readableStream,
      stream: decryptedStream
    }
  }

  isEncrypted(): boolean {
    if (
      this.file.encryptedBy &&
      (this.file.encryptMethod === EncryptMethod.AES ||
        this.file.encryptMethod === EncryptMethod.ECIES)
    ) {
      return true
    } else {
      return false
    }
  }

  canDecrypt(nodeId: string): boolean {
    if (
      this.file.encryptedBy === nodeId &&
      (this.file.encryptMethod === EncryptMethod.AES ||
        this.file.encryptMethod === EncryptMethod.ECIES)
    ) {
      return true
    } else {
      return false
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
    const file: UrlFileObject = this.getFile() as UrlFileObject
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

  async fetchSpecificFileMetadata(fileObject: UrlFileObject): Promise<FileInfoResponse> {
    const { url } = fileObject
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: new URL(url).pathname.split('/').pop() || '',
      type: 'url',
      encryptedBy: fileObject.encryptedBy,
      encryptMethod: fileObject.encryptMethod
    }
  }

  async encryptContent(
    encryptionType: EncryptMethod.AES | EncryptMethod.ECIES
  ): Promise<Buffer> {
    const file = this.getFile()
    const response = await axios({
      url: file.url,
      method: file.method || 'get',
      headers: file.headers
    })
    return await encryptData(response.data, encryptionType)
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
    const file: ArweaveFileObject = this.getFile() as ArweaveFileObject
    if (!file.transactionId) {
      return [false, 'Missing transaction ID']
    }
    return [true, '']
  }

  getDownloadUrl(): string {
    return urlJoin(process.env.ARWEAVE_GATEWAY, this.getFile().transactionId)
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
      type: 'arweave',
      encryptedBy: fileObject.encryptedBy,
      encryptMethod: fileObject.encryptMethod
    }
  }

  async encryptContent(
    encryptionType: EncryptMethod.AES | EncryptMethod.ECIES
  ): Promise<Buffer> {
    const file = this.getFile()
    const response = await axios({
      url: urlJoin(process.env.ARWEAVE_GATEWAY, file.transactionId),
      method: 'get'
    })
    return await encryptData(response.data, encryptionType)
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
    const file: IpfsFileObject = this.getFile() as IpfsFileObject
    if (!file.hash) {
      return [false, 'Missing CID']
    }

    return [true, '']
  }

  getDownloadUrl(): string {
    return urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', this.getFile().hash))
  }

  async fetchSpecificFileMetadata(fileObject: IpfsFileObject): Promise<FileInfoResponse> {
    const url = urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', fileObject.hash))
    const { contentLength, contentType } = await fetchFileMetadata(url)
    return {
      valid: true,
      contentLength,
      contentType,
      name: '',
      type: 'ipfs',
      encryptedBy: fileObject.encryptedBy,
      encryptMethod: fileObject.encryptMethod
    }
  }

  async encryptContent(
    encryptionType: EncryptMethod.AES | EncryptMethod.ECIES
  ): Promise<Buffer> {
    const file = this.getFile()
    const response = await axios({
      url: file.hash,
      method: 'get'
    })
    return await encryptData(response.data, encryptionType)
  }
}
