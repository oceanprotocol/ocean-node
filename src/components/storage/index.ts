import {
  ArweaveFileObject,
  FileInfoRequest,
  FileInfoResponse,
  FileObjectType,
  IpfsFileObject,
  StorageReadable,
  UrlFileObject,
  EncryptMethod,
  S3FileObject,
  S3Object
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { fetchFileMetadata } from '../../utils/asset.js'
import axios from 'axios'
import urlJoin from 'url-join'
import { encrypt as encryptData, decrypt as decryptData } from '../../utils/crypt.js'
import { Readable } from 'stream'
import AWS from 'aws-sdk'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { CORE_LOGGER } from '../../utils/logging/common.js'

export abstract class Storage {
  private file: UrlFileObject | IpfsFileObject | ArweaveFileObject | S3FileObject
  config: OceanNodeConfig
  public constructor(
    file: UrlFileObject | IpfsFileObject | ArweaveFileObject | S3FileObject,
    config: OceanNodeConfig
  ) {
    this.file = file
    this.config = config
  }

  abstract validate(): [boolean, string]
  abstract getDownloadUrl(): string

  abstract fetchSpecificFileMetadata(
    fileObject: any,
    forceChecksum: boolean
  ): Promise<FileInfoResponse>

  abstract encryptContent(encryptionType: 'AES' | 'ECIES'): Promise<Buffer>
  abstract isFilePath(): boolean

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

  static getStorageClass(
    file: any,
    config: OceanNodeConfig
  ): UrlStorage | IpfsStorage | ArweaveStorage | S3Storage {
    const { type } = file
    switch (
      type?.toLowerCase() // case insensitive
    ) {
      case FileObjectType.URL:
        return new UrlStorage(file, config)
      case FileObjectType.IPFS:
        return new IpfsStorage(file, config)
      case FileObjectType.ARWEAVE:
        return new ArweaveStorage(file, config)
      case FileObjectType.S3:
        return new S3Storage(file, config)
      default:
        throw new Error(`Invalid storage type: ${type}`)
    }
  }

  async getFileInfo(
    fileInfoRequest: FileInfoRequest,
    forceChecksum: boolean = false
  ): Promise<FileInfoResponse[]> {
    if (!fileInfoRequest.type) {
      throw new Error('Storage type is not provided')
    }

    const response: FileInfoResponse[] = []

    try {
      const file = this.getFile()

      if (!file) {
        throw new Error('Empty file object')
      } else {
        const fileInfo = await this.fetchSpecificFileMetadata(file, forceChecksum)
        response.push(fileInfo)
      }
    } catch (error) {
      CORE_LOGGER.error(error)
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
    const { keys } = this.config
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
  public constructor(file: UrlFileObject, config: OceanNodeConfig) {
    super(file, config)
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
    if (!['get', 'post'].includes(file.method?.toLowerCase())) {
      return [false, 'Invalid method for URL']
    }
    if (this.config && this.config.unsafeURLs) {
      for (const regex of this.config.unsafeURLs) {
        try {
          // eslint-disable-next-line security/detect-non-literal-regexp
          const pattern = new RegExp(regex)
          if (pattern.test(file.url)) {
            return [false, 'URL is marked as unsafe']
          }
        } catch (e) {}
      }
    }
    if (this.isFilePath() === true) {
      return [false, 'URL looks like a file path']
    }

    return [true, '']
  }

  isFilePath(): boolean {
    const regex: RegExp = /^(.+)\/([^/]*)$/ // The URL should not represent a path
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

  async fetchSpecificFileMetadata(
    fileObject: UrlFileObject,
    forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const { url, method } = fileObject
    const { contentLength, contentType, contentChecksum } = await fetchFileMetadata(
      url,
      method,
      forceChecksum
    )
    return {
      valid: true,
      contentLength,
      contentType,
      checksum: contentChecksum,
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
  public constructor(file: ArweaveFileObject, config: OceanNodeConfig) {
    super(file, config)

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
    return urlJoin(process.env.ARWEAVE_GATEWAY, this.getFile().transactionId)
  }

  async fetchSpecificFileMetadata(
    fileObject: ArweaveFileObject,
    forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const url = urlJoin(process.env.ARWEAVE_GATEWAY, fileObject.transactionId)
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
  public constructor(file: IpfsFileObject, config: OceanNodeConfig) {
    super(file, config)

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
    if (file.hash.startsWith('http://') || file.hash.startsWith('https://')) {
      return [false, 'CID looks like an URL. Please specify URL storage instead.']
    }
    if (this.isFilePath() === true) {
      return [false, 'CID looks like a file path']
    }
    return [true, '']
  }

  isFilePath(): boolean {
    const regex: RegExp = /^(.+)\/([^/]*)$/ // The CID should not represent a path
    const { hash } = this.getFile()

    return regex.test(hash)
  }

  getDownloadUrl(): string {
    return urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', this.getFile().hash))
  }

  async fetchSpecificFileMetadata(
    fileObject: IpfsFileObject,
    forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const url = urlJoin(process.env.IPFS_GATEWAY, urlJoin('/ipfs', fileObject.hash))
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

export class S3Storage extends Storage {
  public constructor(file: S3FileObject, config: OceanNodeConfig) {
    super(file, config)
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validationg the S3 file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    const file: S3FileObject = this.getFile() as S3FileObject
    if (!file.s3Access) {
      return [false, 'Missing s3Access']
    }
    return [true, '']
  }

  parseDecryptedStream(decryptedStream: Readable): Promise<S3Object> {
    return new Promise((resolve, reject) => {
      let data = ''
      decryptedStream.on('data', (chunk) => {
        data += chunk
      })
      decryptedStream.on('end', () => {
        try {
          const parsedData = JSON.parse(data)
          resolve(parsedData)
        } catch (error) {
          reject(error)
        }
      })
      decryptedStream.on('error', (error) => {
        reject(error)
      })
    })
  }

  isFilePath(): boolean {
    const { endpoint } = this.getFile().s3Access
    return endpoint.includes('.')
  }

  getDownloadUrl(): string {
    const { s3Access } = this.getFile()
    return JSON.stringify(s3Access)
  }

  async fetchDataContent(): Promise<any> {
    const s3Obj = await this.getFile().s3Access
    const spacesEndpoint = new AWS.Endpoint(s3Obj.endpoint)
    const s3 = new AWS.S3({
      endpoint: spacesEndpoint,
      accessKeyId: s3Obj.accessKeyId,
      secretAccessKey: s3Obj.secretAccessKey,
      region: s3Obj.region
    })

    const params = {
      Bucket: s3Obj.bucket,
      Key: s3Obj.objectKey
    }
    try {
      const data = await s3.getObject(params).promise()
      console.log('Successfully fetched data from S3')
      return data
    } catch (err) {
      console.error('Error fetching object from S3:', err)
    }
  }

  async fetchDataStream(): Promise<any> {
    const s3Obj = await this.getFile().s3Access
    const spacesEndpoint = new AWS.Endpoint(s3Obj.endpoint)
    const s3Client = new S3Client({
      endpoint: {
        hostname: spacesEndpoint.hostname,
        protocol: spacesEndpoint.protocol,
        path: '/'
      },
      region: s3Obj.region,
      credentials: {
        accessKeyId: s3Obj.accessKeyId,
        secretAccessKey: s3Obj.secretAccessKey
      }
    })

    const params = {
      Bucket: s3Obj.bucket,
      Key: s3Obj.objectKey
    }
    try {
      const response = await s3Client.send(new GetObjectCommand(params))

      const dataStream = response.Body
      console.log('Successfully retrieved object from S3')
      return dataStream
    } catch (err) {
      console.error('Error fetching object from S3:', err)
    }
  }

  async fetchSpecificFileMetadata(): Promise<FileInfoResponse> {
    const data = await this.fetchDataContent()
    const s3Obj = await this.getFile().s3Access
    return {
      valid: true,
      contentLength: data.ContentLength,
      contentType: data.ContentType,
      name: s3Obj.objectKey,
      type: 's3',
      encryptedBy: this.getFile().encryptedBy,
      encryptMethod: this.getFile().encryptMethod
    }
  }

  async encryptContent(
    encryptionType: EncryptMethod.AES | EncryptMethod.ECIES
  ): Promise<Buffer> {
    const data = await this.fetchDataContent()
    return await encryptData(data, encryptionType)
  }
}
