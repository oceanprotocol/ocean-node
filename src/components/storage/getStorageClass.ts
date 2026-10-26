import { FileObjectType } from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'

import { ArweaveStorage } from './ArweaveStorage.js'
import { FTPStorage } from './FTPStorage.js'
import { IpfsStorage } from './IpfsStorage.js'
import { S3Storage } from './S3Storage.js'
import { UrlStorage } from './UrlStorage.js'
import { NodePersistentStorage } from './NodePersistentStorage.js'

export type StorageClass =
  | UrlStorage
  | IpfsStorage
  | ArweaveStorage
  | S3Storage
  | FTPStorage
  | NodePersistentStorage

export function getStorageClass(
  file: any,
  config: OceanNodeConfig,
  consumerAddress?: string
): StorageClass {
  if (!file) {
    throw new Error('Empty file object')
  }
  try {
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
      case FileObjectType.FTP:
        return new FTPStorage(file, config)
      case FileObjectType.NODE_PERSISTENT_STORAGE.toLowerCase():
        return new NodePersistentStorage(file, config, consumerAddress)
      default:
        throw new Error(`Invalid storage type: ${type}`)
    }
  } catch (err) {
    CORE_LOGGER.error(`Error in getStorageClass: ${err.message}`)
    throw err
  }
}
