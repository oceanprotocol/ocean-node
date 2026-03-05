import { FileObjectType } from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

import { ArweaveStorage } from './ArweaveStorage.js'
import { IpfsStorage } from './IpfsStorage.js'
import { UrlStorage } from './UrlStorage.js'

export function getStorageClass(
  file: any,
  config: OceanNodeConfig
): UrlStorage | IpfsStorage | ArweaveStorage {
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
      default:
        throw new Error(`Invalid storage type: ${type}`)
    }
  } catch (err) {
    console.error('Error in getStorageClass: ', err)
    throw err
  }
}
