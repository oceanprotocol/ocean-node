import { Readable } from 'stream'
import {
  FileInfoResponse,
  PersistentStorageObject,
  StorageReadable
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { OceanNode } from '../../OceanNode.js'
import { PersistentStorageFactory } from '../persistentStorage/PersistentStorageFactory.js'
import { Storage } from './Storage.js'

/**
 * Storage class for node persistent-storage (localfs bucket) file objects.
 * Unlike the other backends, persistent storage lives on the node itself, so this
 * class reaches it through the OceanNode singleton. ACL is enforced by the backend
 * whenever a consumerAddress is available (captured at construction time, since the
 * Storage interface does not pass it to the read methods).
 */
export class NodePersistentStorage extends Storage {
  private consumerAddress?: string

  public constructor(
    file: PersistentStorageObject,
    config: OceanNodeConfig,
    consumerAddress?: string
  ) {
    super(file, config, false)
    this.consumerAddress = consumerAddress
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validating the persistent storage file: ${message}`)
    }
  }

  private backend(): PersistentStorageFactory {
    if (!this.config.persistentStorage?.enabled) {
      throw new Error('Persistent storage is not enabled on this node')
    }
    const ps = OceanNode.getInstance().getPersistentStorage()
    if (!ps) {
      throw new Error('Persistent storage is not available on this node')
    }
    return ps
  }

  validate(): [boolean, string] {
    const file = this.getFile() as PersistentStorageObject
    if (!file?.bucketId) {
      return [false, 'Missing bucketId']
    }
    if (!file?.fileName) {
      return [false, 'Missing fileName']
    }
    if (!this.config.persistentStorage?.enabled) {
      return [false, 'Persistent storage is not enabled on this node']
    }
    // Stay backend-agnostic: a non-localfs backend will throw at read time.
    return [true, '']
  }

  override async getReadableStream(): Promise<StorageReadable> {
    const { bucketId, fileName } = this.getFile() as PersistentStorageObject
    const stream = await this.backend().getReadableStream(
      bucketId,
      fileName,
      this.consumerAddress
    )
    return { stream: stream as Readable, httpStatus: 200, headers: {} }
  }

  async fetchSpecificFileMetadata(
    fileObject: PersistentStorageObject,
    forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const { bucketId, fileName } = fileObject
    const ps = this.backend()
    const { size } = await ps.getFileInfo(bucketId, fileName, this.consumerAddress)
    // getFileChecksum always enforces ACL and requires a consumerAddress; skip when absent.
    let checksum: string | undefined
    if (forceChecksum && this.consumerAddress) {
      checksum = await ps.getFileChecksum(bucketId, fileName, this.consumerAddress)
    }
    return {
      valid: true,
      contentLength: String(size),
      contentType: 'application/octet-stream',
      checksum,
      name: fileName,
      type: 'nodePersistentStorage'
    }
  }
}
