import {
  FileInfoResponse,
  StorageReadable,
  UrlFileObject
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { fetchFileMetadata } from '../../utils/asset.js'
import axios from 'axios'

import { Storage } from './Storage.js'

export class UrlStorage extends Storage {
  public constructor(file: UrlFileObject, config: OceanNodeConfig) {
    super(file, config)
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validating the URL file: ${message}`)
    }
  }

  async getReadableStream(): Promise<StorageReadable> {
    const input = this.getDownloadUrl()
    const file = this.getFile()
    const { headers } = file
    const response = await axios({
      method: 'get',
      url: input,
      headers,
      responseType: 'stream',
      timeout: 30000
    })

    return {
      httpStatus: response.status,
      stream: response.data,
      headers: response.headers as any
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
    const { url, method, headers } = fileObject
    const { contentLength, contentType, contentChecksum } = await fetchFileMetadata(
      url,
      method || 'get',
      forceChecksum,
      headers
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
}
