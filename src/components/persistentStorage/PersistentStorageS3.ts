import {
  CreateBucketResult,
  PersistentStorageBucketRecord,
  PersistentStorageFactory,
  PersistentStorageFileInfo
} from './PersistentStorageFactory.js'

import type { AccessList } from '../../@types/AccessList.js'
import type {
  DockerMountObject,
  PersistentStorageS3Options,
  PersistentStorageObject
} from '../../@types/PersistentStorage.js'
import { OceanNode } from '../../OceanNode.js'

export class PersistentStorageS3 extends PersistentStorageFactory {
  private options: PersistentStorageS3Options
  constructor(node: OceanNode) {
    super(node)
    this.options = node.getConfig().persistentStorage
      .options as PersistentStorageS3Options
  }

  // eslint-disable-next-line require-await
  async init(): Promise<void> {
    throw new Error('PersistentStorageS3 is not implemented yet')
  }

  async listBuckets(owner: string): Promise<PersistentStorageBucketRecord[]> {
    await this.init()
    return super.listBuckets(owner)
  }

  // eslint-disable-next-line require-await
  async createNewBucket(
    accessList: AccessList[],
    _owner: string
  ): Promise<CreateBucketResult> {
    throw new Error('PersistentStorageS3 is not implemented yet')
  }

  // eslint-disable-next-line require-await
  async listFiles(
    _bucketId: string,
    _consumerAddress: string
  ): Promise<PersistentStorageFileInfo[]> {
    throw new Error('PersistentStorageS3 is not implemented yet')
  }

  // eslint-disable-next-line require-await
  async uploadFile(
    _bucketId: string,
    _fileName: string,
    _content: Buffer | NodeJS.ReadableStream,
    _consumerAddress: string
  ): Promise<PersistentStorageFileInfo> {
    throw new Error('PersistentStorageS3 is not implemented yet')
  }

  // eslint-disable-next-line require-await
  async deleteFile(
    _bucketId: string,
    _fileName: string,
    _consumerAddress: string
  ): Promise<void> {
    throw new Error('PersistentStorageS3 is not implemented yet')
  }

  // eslint-disable-next-line require-await
  async getFileObject(
    _bucketId: string,
    _fileName: string,
    _consumerAddress: string
  ): Promise<PersistentStorageObject> {
    throw new Error('PersistentStorageS3 is not implemented yet')
  }

  // eslint-disable-next-line require-await
  async getDockerMountObject(
    _bucketId: string,
    _fileName: string,
    _consumerAddress?: string
  ): Promise<DockerMountObject> {
    throw new Error('PersistentStorageS3 is not implemented yet')
  }
}
