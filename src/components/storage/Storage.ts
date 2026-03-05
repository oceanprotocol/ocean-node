import {
  FileInfoRequest,
  FileInfoResponse,
  FileObjectType,
  StorageReadable,
  StorageObject,
  EncryptMethod
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import axios from 'axios'

import { CORE_LOGGER } from '../../utils/logging/common.js'

export abstract class Storage {
  // eslint-disable-next-line no-use-before-define -- static factory return type references this class
  static getStorageClass: (file: any, config: OceanNodeConfig) => Storage

  private file: StorageObject
  config: OceanNodeConfig
  public constructor(file: StorageObject, config: OceanNodeConfig) {
    this.file = file
    this.config = config
  }

  abstract validate(): [boolean, string]
  abstract getDownloadUrl(): string

  abstract fetchSpecificFileMetadata(
    fileObject: any,
    forceChecksum: boolean
  ): Promise<FileInfoResponse>

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
      responseType: 'stream',
      timeout: 30000
    })

    return {
      httpStatus: response.status,
      stream: response.data,
      headers: response.headers as any
    }
  }

  getStorageType(file: any): FileObjectType {
    const { type } = file
    return type
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
