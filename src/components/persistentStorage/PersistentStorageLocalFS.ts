import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { randomUUID } from 'crypto'

import type { AccessList } from '../../@types/AccessList.js'
import type {
  DockerMountObject,
  PersistentStorageLocalFSOptions,
  PersistentStorageObject
} from '../../@types/PersistentStorage.js'

import {
  CreateBucketResult,
  PersistentStorageBucketRecord,
  PersistentStorageFactory,
  PersistentStorageFileInfo
} from './PersistentStorageFactory.js'
import { OceanNode } from '../../OceanNode.js'

export class PersistentStorageLocalFS extends PersistentStorageFactory {
  /* eslint-disable security/detect-non-literal-fs-filename -- localfs backend operates on filesystem paths */
  private baseFolder: string

  constructor(node: OceanNode) {
    super(node)
    const options = node.getConfig().persistentStorage
      .options as PersistentStorageLocalFSOptions

    this.baseFolder = options.folder
    fsp.mkdir(this.baseFolder, { recursive: true })
  }

  private bucketPath(bucketId: string): string {
    return path.join(this.baseFolder, 'buckets', bucketId)
  }

  private async ensureBucketExists(bucketId: string): Promise<void> {
    this.validateBucket(bucketId)
    const bucketsRoot = path.resolve(this.baseFolder, 'buckets')
    const resolvedBucketPath = path.resolve(this.bucketPath(bucketId))
    if (
      resolvedBucketPath !== bucketsRoot &&
      !resolvedBucketPath.startsWith(bucketsRoot + path.sep)
    ) {
      throw new Error('Invalid bucketId')
    }
    const row = await this.dbGetBucket(bucketId)
    if (!row) {
      throw new Error(`Bucket not found: ${bucketId}`)
    }
  }

  private async ensureFileExists(bucketId: string, fileName: string): Promise<void> {
    if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('Invalid fileName')
    }
    const targetPath = path.join(this.bucketPath(bucketId), fileName)
    try {
      const st = await fsp.stat(targetPath)
      if (!st.isFile()) {
        throw new Error(`File not found: ${fileName}`)
      }
    } catch {
      throw new Error(`File not found: ${fileName}`)
    }
  }

  // eslint-disable-next-line require-await
  async listBuckets(owner: string): Promise<PersistentStorageBucketRecord[]> {
    return super.listBuckets(owner)
  }

  async createNewBucket(
    accessList: AccessList[],
    owner: string
  ): Promise<CreateBucketResult> {
    const bucketId = randomUUID()
    const createdAt = Math.floor(Date.now() / 1000)
    await fsp.mkdir(this.bucketPath(bucketId), { recursive: true })
    await super.dbUpsertBucket(
      bucketId,
      owner,
      JSON.stringify(accessList ?? []),
      createdAt
    )

    return { bucketId, owner, accessList }
  }

  async listFiles(
    bucketId: string,
    consumerAddress: string
  ): Promise<PersistentStorageFileInfo[]> {
    await this.ensureBucketExists(bucketId)
    await this.assertConsumerAllowedForBucket(consumerAddress, bucketId)

    const dir = this.bucketPath(bucketId)
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const out: PersistentStorageFileInfo[] = []

    for (const ent of entries) {
      if (!ent.isFile()) continue
      const filePath = path.join(dir, ent.name)
      const st = await fsp.stat(filePath)
      out.push({
        bucketId,
        name: ent.name,
        size: st.size,
        lastModified: Math.floor(st.mtimeMs)
      })
    }

    return out
  }

  async uploadFile(
    bucketId: string,
    fileName: string,
    content: NodeJS.ReadableStream,
    consumerAddress: string
  ): Promise<PersistentStorageFileInfo> {
    await this.ensureBucketExists(bucketId)
    await this.assertConsumerAllowedForBucket(consumerAddress, bucketId)

    if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
      throw new Error('Invalid fileName')
    }

    const targetDir = this.bucketPath(bucketId)
    await fsp.mkdir(targetDir, { recursive: true })
    const targetPath = path.join(targetDir, fileName)

    await pipeline(content, fs.createWriteStream(targetPath))

    const st = await fsp.stat(targetPath)
    return {
      bucketId,
      name: fileName,
      size: st.size,
      lastModified: Math.floor(st.mtimeMs)
    }
  }

  async deleteFile(
    bucketId: string,
    fileName: string,
    consumerAddress: string
  ): Promise<void> {
    await this.ensureBucketExists(bucketId)
    await this.assertConsumerAllowedForBucket(consumerAddress, bucketId)
    await this.ensureFileExists(bucketId, fileName)

    const targetPath = path.join(this.bucketPath(bucketId), fileName)
    await fsp.rm(targetPath)
  }

  async getFileObject(
    bucketId: string,
    fileName: string,
    consumerAddress: string
  ): Promise<PersistentStorageObject> {
    await this.ensureBucketExists(bucketId)
    await this.assertConsumerAllowedForBucket(consumerAddress, bucketId)
    await this.ensureFileExists(bucketId, fileName)

    // This is intentionally not a downloadable URL; compute backends can interpret this object.
    const obj: PersistentStorageObject = {
      type: 'nodePersistentStorage',
      bucketId,
      fileName
    }
    return obj
  }

  async getDockerMountObject(
    bucketId: string,
    fileName: string,
    consumerAddress?: string
  ): Promise<DockerMountObject> {
    await this.ensureBucketExists(bucketId)
    if (consumerAddress) {
      await this.assertConsumerAllowedForBucket(consumerAddress, bucketId)
    }
    await this.ensureFileExists(bucketId, fileName)

    const source = path.join(this.bucketPath(bucketId), fileName)
    const target = path.posix.join('/data', 'persistentStorage', bucketId, fileName)

    return {
      Type: 'bind',
      Source: source,
      Target: target,
      ReadOnly: true
    }
  }
}
/* eslint-enable security/detect-non-literal-fs-filename */
