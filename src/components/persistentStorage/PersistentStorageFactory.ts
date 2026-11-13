import { P2PCommandResponse } from '../../@types/index.js'
import { isPersistentStorageType } from '../../@types/fileObject.js'
import type { AccessList } from '../../@types/AccessList.js'
import type {
  DockerMountObject,
  PersistentStorageObject
} from '../../@types/PersistentStorage.js'

import type { BucketRegistry, BucketRow } from '../database/BucketRegistry.js'
import { getAddress } from 'ethers'
import { OceanNode } from '../../OceanNode.js'
import { checkAddressOnAccessList } from '../../utils/accessList.js'

export class PersistentStorageAccessDeniedError extends Error {
  constructor(message = 'You are not allowed to access this bucket') {
    super(message)
    this.name = 'PersistentStorageAccessDeniedError'
  }
}

function normalizeWeb3Address(addr: string): string {
  try {
    return getAddress(addr)
  } catch {
    return (addr ?? '').toLowerCase()
  }
}

function parseBucketAccessListsJson(accessListJson: string): AccessList[] {
  try {
    const parsed = JSON.parse(accessListJson || '[]')
    return Array.isArray(parsed) ? (parsed as AccessList[]) : []
  } catch {
    return []
  }
}

export interface PersistentStorageFileInfo {
  bucketId: string
  name: string
  size: number
  lastModified: number
}

export type CreateBucketResult = {
  bucketId: string
  owner: string
  accessList: AccessList[]
  label?: string | null
}

/** Bucket metadata from registry (list APIs and internal filtering). */
export type PersistentStorageBucketRecord = {
  bucketId: string
  owner: string
  createdAt: number
  accessLists: AccessList[]
  label?: string | null
}

export abstract class PersistentStorageFactory {
  private node: OceanNode
  private buckets: BucketRegistry

  constructor(node: OceanNode, buckets: BucketRegistry) {
    this.node = node
    this.buckets = buckets
  }

  /**
   * Validate a bucket id. Today localfs uses UUIDs, so enforce UUIDv4.
   * This is a security boundary because bucketId participates in filesystem paths.
   */
  public validateBucket(bucketId: string): void {
    // UUID v4: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
    const uuidV4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (typeof bucketId !== 'string' || !uuidV4.test(bucketId)) {
      throw new Error('Invalid bucketId')
    }
  }

  public abstract createNewBucket(
    accessList: AccessList[],
    owner: string,
    label?: string
  ): Promise<CreateBucketResult>

  public abstract listFiles(
    bucketId: string,
    consumerAddress: string
  ): Promise<PersistentStorageFileInfo[]>

  public abstract uploadFile(
    bucketId: string,
    fileName: string,
    content: NodeJS.ReadableStream,
    consumerAddress: string
  ): Promise<PersistentStorageFileInfo>

  public abstract deleteFile(
    bucketId: string,
    fileName: string,
    consumerAddress: string
  ): Promise<void>

  /**
   * Returns a file object that can be attached to compute jobs.
   * The concrete shape depends on the backend implementation.
   */
  public abstract getFileObject(
    bucketId: string,
    fileName: string,
    consumerAddress: string
  ): Promise<PersistentStorageObject>

  /**
   * Returns a Docker mount descriptor for a specific bucket file.
   * This is used by the Docker C2D engine to mount the file into the job container.
   */
  public abstract getDockerMountObject(
    bucketId: string,
    fileName: string,
    consumerAddress: string
  ): Promise<DockerMountObject>

  public abstract getDockerOutputMountObject(
    bucketId: string,
    consumerAddress: string
  ): Promise<DockerMountObject>

  /**
   * Returns a sha256 checksum of a bucket file's contents.
   * Used to compute algorithm file checksums for compute jobs that reference
   * persistent storage.
   */
  public abstract getFileChecksum(
    bucketId: string,
    fileName: string,
    consumerAddress?: string
  ): Promise<string>

  /**
   * Stat-like metadata for a bucket file. ACL is enforced only when
   * `consumerAddress` is provided (mirrors `getDockerMountObject`).
   */
  public abstract getFileInfo(
    bucketId: string,
    fileName: string,
    consumerAddress?: string
  ): Promise<{ size: number; lastModified: number }>

  /**
   * Returns a readable stream of a bucket file's contents. ACL is enforced only
   * when `consumerAddress` is provided. Backs the NodePersistentStorage class.
   */
  public abstract getReadableStream(
    bucketId: string,
    fileName: string,
    consumerAddress?: string
  ): Promise<NodeJS.ReadableStream>

  // common functions
  async getBucketAccessList(bucketId: string): Promise<AccessList[]> {
    try {
      const row = await this.getBucket(bucketId)
      if (!row) {
        return []
      }
      return parseBucketAccessListsJson(row.accessListJson)
    } catch {
      return []
    }
  }

  async getBucket(bucketId: string): Promise<BucketRow | null> {
    try {
      const row = await this.dbGetBucket(bucketId)
      return row
    } catch {
      return null
    }
  }

  /**
   * Lists buckets for a given owner from the bucket registry (metadata only).
   * `owner` must already be normalized (e.g. checksummed `getAddress`).
   * Backends that need setup (e.g. localfs init) should override and call `super.listBuckets(owner)`.
   */
  async listBuckets(owner: string): Promise<PersistentStorageBucketRecord[]> {
    const rows = await this.dbListBucketsByOwner(owner)
    return rows.map((row) => ({
      bucketId: row.bucketId,
      owner: row.owner,
      createdAt: row.createdAt,
      accessLists: parseBucketAccessListsJson(row.accessListJson),
      label: row.label ?? null
    }))
  }

  /**
   * Lists the owner's buckets that `consumer` may use: all of them for the owner, otherwise
   * only those whose access list includes the consumer (none when sharing is disabled).
   * Both addresses must already be normalized (checksummed `getAddress`).
   */
  async listBucketsForConsumer(
    owner: string,
    consumer: string
  ): Promise<PersistentStorageBucketRecord[]> {
    const buckets = await this.listBuckets(owner)
    if (consumer === owner) {
      return buckets
    }
    if (!this.isBucketSharingAllowed()) {
      return []
    }
    // Buckets often share an access list; check each distinct list only once.
    const checks = new Map<string, Promise<boolean>>()
    const allowed = await Promise.all(
      buckets.map((bucket) => {
        const key = JSON.stringify(bucket.accessLists)
        if (!checks.has(key)) {
          checks.set(key, this.isAllowed(consumer, bucket.accessLists))
        }
        return checks.get(key)
      })
    )
    return buckets.filter((_, i) => allowed[i])
  }

  dbUpsertBucket(
    bucketId: string,
    owner: string,
    accessListJson: string,
    createdAt: number,
    label: string | null
  ): Promise<void> {
    return this.buckets.upsertBucket(bucketId, owner, accessListJson, createdAt, label)
  }

  dbGetBucket(bucketId: string): Promise<BucketRow | null> {
    return this.buckets.getBucket(bucketId)
  }

  dbListBucketsByOwner(owner: string): Promise<BucketRow[]> {
    return this.buckets.listBucketsByOwner(owner)
  }

  dbDeleteBucket(bucketId: string): Promise<boolean> {
    return this.buckets.deleteBucket(bucketId)
  }

  dbUpdateBucketLabel(
    bucketId: string,
    owner: string,
    label: string | null
  ): Promise<boolean> {
    return this.buckets.updateBucketLabel(bucketId, owner, label)
  }

  isAllowed(consumerAddress: string, accessLists: AccessList[]): Promise<boolean> {
    return checkAddressOnAccessList(consumerAddress, accessLists, this.node)
  }

  /** Whether bucket access lists are honoured (off by default). When off, only the bucket owner can use a bucket. */
  public isBucketSharingAllowed(): boolean {
    return this.node.getConfig().persistentStorage?.allowBucketSharing === true
  }

  /**
   * Throws {@link PersistentStorageAccessDeniedError} if the consumer is neither the owner
   * nor on the bucket access list (the access list is ignored when sharing is disabled).
   */
  public async assertConsumerAllowedForBucket(
    consumerAddress: string,
    bucketId: string
  ): Promise<void> {
    const bucket = await this.getBucket(bucketId)
    if (!bucket) {
      throw new PersistentStorageAccessDeniedError()
    }
    const accessLists = parseBucketAccessListsJson(bucket.accessListJson)
    if (normalizeWeb3Address(consumerAddress) === normalizeWeb3Address(bucket.owner)) {
      return
    }
    if (!this.isBucketSharingAllowed()) {
      throw new PersistentStorageAccessDeniedError()
    }
    if (!(await this.isAllowed(consumerAddress, accessLists))) {
      throw new PersistentStorageAccessDeniedError()
    }
  }

  public async updateBucketLabel(
    bucketId: string,
    label: string | null | undefined,
    owner: string
  ): Promise<string | null> {
    this.validateBucket(bucketId)
    const bucket = await this.getBucket(bucketId)
    if (!bucket) {
      throw new Error(`Bucket not found: ${bucketId}`)
    }
    if (normalizeWeb3Address(owner) !== normalizeWeb3Address(bucket.owner)) {
      throw new PersistentStorageAccessDeniedError()
    }
    // Omitted label leaves the name unchanged (PATCH semantics); null/'' clears it.
    if (label === undefined) {
      return bucket.label ?? null
    }
    const normalized = label && label.trim() ? label.trim() : null
    const updated = await this.dbUpdateBucketLabel(
      bucketId,
      normalizeWeb3Address(bucket.owner),
      normalized
    )
    if (!updated) {
      throw new Error(`Bucket not found: ${bucketId}`)
    }
    return normalized
  }
}

/**
 * When a compute dataset or algorithm uses a node persistent-storage file (localfs backend),
 * ensure the consumer is on the bucket ACL before proceeding.
 */
export async function ensureConsumerAllowedForPersistentStorageLocalfsFileObject(
  node: OceanNode,
  consumerAddress: string,
  fileObject: unknown
): Promise<P2PCommandResponse | null> {
  if (fileObject === null || fileObject === undefined || typeof fileObject !== 'object') {
    return null
  }
  const fo = fileObject as { type?: string; bucketId?: unknown }
  if (!isPersistentStorageType(fo.type)) {
    return null
  }
  if (typeof fo.bucketId !== 'string' || fo.bucketId.length === 0) {
    return {
      stream: null,
      status: {
        httpStatus: 400,
        error: 'Persistent storage file object is missing a valid bucketId'
      }
    }
  }
  const cfg = node.getConfig().persistentStorage
  if (!cfg?.enabled || cfg.type !== 'localfs') {
    return {
      stream: null,
      status: {
        httpStatus: 400,
        error:
          'This compute job references node persistent storage (localfs), which is not enabled or not configured as localfs on this node'
      }
    }
  }
  const storage = node.getPersistentStorage()
  if (!storage) {
    return {
      stream: null,
      status: {
        httpStatus: 400,
        error:
          'This compute job references node persistent storage but persistent storage is not available on this node'
      }
    }
  }
  try {
    await storage.assertConsumerAllowedForBucket(consumerAddress, fo.bucketId)
  } catch (e) {
    if (e instanceof PersistentStorageAccessDeniedError) {
      return {
        stream: null,
        status: { httpStatus: 403, error: e.message }
      }
    }
    throw e
  }
  return null
}
