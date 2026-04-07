import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { pipeline } from 'stream/promises'
import { randomUUID } from 'crypto'

import type { AccessList } from '../../@types/AccessList.js'
import type { PersistentStorageLocalFSOptions } from '../../@types/PersistentStorage.js'
import type { BaseFileObject } from '../../@types/fileObject.js'

import {
  CreateBucketResult,
  PersistentStorageBucketRecord,
  PersistentStorageFactory,
  PersistentStorageFileInfo
} from './PersistentStorageFactory.js'
import { OceanNode } from '../../OceanNode.js'

type LocalFileObject = BaseFileObject & {
  type: 'localfs'
  bucketId: string
  fileName: string
}

export class PersistentStorageLocalFS extends PersistentStorageFactory {
  private baseFolder: string

  constructor(node: OceanNode) {
    super(node)
    const options = node.getConfig().persistentStorage
      .options as PersistentStorageLocalFSOptions

    this.baseFolder = options.folder
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.baseFolder, { recursive: true })
    await super.dbCreateTables()
  }

  private bucketPath(bucketId: string): string {
    return path.join(this.baseFolder, 'buckets', bucketId)
  }

  private async ensureBucketExists(bucketId: string): Promise<void> {
    const row = await this.dbGetBucket(bucketId)
    if (!row) {
      throw new Error(`Bucket not found: ${bucketId}`)
    }
  }

  async listBuckets(owner: string): Promise<PersistentStorageBucketRecord[]> {
    await this.init()
    return super.listBuckets(owner)
  }

  async createNewBucket(
    accessList: AccessList[],
    owner: string
  ): Promise<CreateBucketResult> {
    await this.init()

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
    await this.init()
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
    await this.init()
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
    await this.init()
    await this.ensureBucketExists(bucketId)
    await this.assertConsumerAllowedForBucket(consumerAddress, bucketId)

    const targetPath = path.join(this.bucketPath(bucketId), fileName)
    await fsp.rm(targetPath, { force: true })
  }

  async getFileObject(
    bucketId: string,
    fileName: string,
    consumerAddress: string
  ): Promise<BaseFileObject> {
    await this.init()
    await this.ensureBucketExists(bucketId)
    await this.assertConsumerAllowedForBucket(consumerAddress, bucketId)

    // This is intentionally not a downloadable URL; compute backends can interpret this object.
    const obj: LocalFileObject = {
      type: 'localfs',
      bucketId,
      fileName
    }
    return obj
  }
}
