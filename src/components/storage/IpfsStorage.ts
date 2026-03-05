import {
  FileInfoResponse,
  IpfsFileObject,
  StorageReadable
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { fetchFileMetadata } from '../../utils/asset.js'
import urlJoin from 'url-join'
import axios from 'axios'
import { Storage } from './Storage.js'

export class IpfsStorage extends Storage {
  public constructor(file: IpfsFileObject, config: OceanNodeConfig) {
    super(file, config)

    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validating the IPFS file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    if (!this.config.ipfsGateway) {
      return [false, 'IPFS gateway is not configured!']
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
    return urlJoin(this.config.ipfsGateway, urlJoin('/ipfs', this.getFile().hash))
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
    fileObject: IpfsFileObject,
    forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const url = urlJoin(this.config.ipfsGateway, urlJoin('/ipfs', fileObject.hash))
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
}
