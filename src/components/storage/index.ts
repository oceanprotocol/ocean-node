import { getStorageClass } from './getStorageClass.js'
import { Storage } from './Storage.js'
import { ArweaveStorage } from './ArweaveStorage.js'
import { IpfsStorage } from './IpfsStorage.js'
import { UrlStorage } from './UrlStorage.js'

Storage.getStorageClass = getStorageClass

export { Storage, UrlStorage, ArweaveStorage, IpfsStorage }
