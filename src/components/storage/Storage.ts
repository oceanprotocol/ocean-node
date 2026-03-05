import {
  FileInfoRequest,
  FileInfoResponse,
  FileObjectType,
  StorageReadable,
  StorageObject,
  EncryptMethod
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

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

  abstract fetchSpecificFileMetadata(
    fileObject: any,
    forceChecksum: boolean
  ): Promise<FileInfoResponse>

  getFile(): any {
    return this.file
  }

  abstract getReadableStream(): Promise<StorageReadable>

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
      CORE_LOGGER.error(error.message)
      throw error
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
