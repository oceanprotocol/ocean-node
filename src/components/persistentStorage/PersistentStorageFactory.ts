import { P2PCommandResponse } from '../../@types/index.js'
import { isPersistentStorageType } from '../../@types/fileObject.js'
import type { AccessList } from '../../@types/AccessList.js'
import type {
  DockerMountObject,
  PersistentStorageObject
} from '../../@types/PersistentStorage.js'

import { SqliteClient } from '../database/sqliteClient.js'
import { getAddress } from 'ethers'
import { OceanNode } from '../../OceanNode.js'
import { checkAddressOnAccessList } from '../../utils/accessList.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import {
  DEFAULT_SERVICE_BUCKET_QUOTA_BYTES,
  DEFAULT_SERVICE_BUCKET_RETENTION_SECONDS
} from '../../utils/config/constants.js'

export class PersistentStorageAccessDeniedError extends Error {
  constructor(message = 'You are not allowed to access this bucket') {
    super(message)
    this.name = 'PersistentStorageAccessDeniedError'
  }
}

export class PersistentStorageQuotaExceededError extends Error {
  constructor(bucketId: string, usedBytes: number, quotaBytes: number) {
    super(
      `Bucket ${bucketId} is over its quota (${usedBytes} of ${quotaBytes} bytes used) — ` +
        'delete files from it to free space'
    )
    this.name = 'PersistentStorageQuotaExceededError'
  }
}

export type CreateBucketOptions = {
  serviceId?: string // the service the bucket was auto-created for (at most one bucket each)
  quotaBytes?: number
  expiresAt?: number // unix seconds; the expiry sweep deletes the bucket after this
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

export type BucketRow = {
  bucketId: string
  owner: string
  accessListJson: string
  createdAt: number
  label: string | null
  serviceId: string | null
  quotaBytes: number | null
  expiresAt: number | null
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
  serviceId?: string | null
  quotaBytes?: number | null
  expiresAt?: number | null
}

/** Bucket metadata from registry (list APIs and internal filtering). */
export type PersistentStorageBucketRecord = {
  bucketId: string
  owner: string
  createdAt: number
  accessLists: AccessList[]
  label?: string | null
  serviceId?: string | null
  quotaBytes?: number | null
  expiresAt?: number | null
}

const BUCKET_COLUMNS =
  'bucketId, owner, accessListJson, createdAt, label, serviceId, quotaBytes, expiresAt'

export abstract class PersistentStorageFactory {
  private db: SqliteClient
  private node: OceanNode
  private dbReady = false
  private dbReadyPromise: Promise<void>
  // bucketId → last measured size, see getBucketQuotaUsage
  private bucketUsageCache: Map<string, { usedBytes: number; at: number }> = new Map()

  constructor(node: OceanNode) {
    this.node = node
    // SqliteClient creates the parent directory on construction.
    this.db = new SqliteClient('databases/persistentStorage.sqlite')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persistent_storage_buckets (
        bucketId TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        accessListJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        label TEXT,
        serviceId TEXT,
        quotaBytes INTEGER,
        expiresAt INTEGER
      );
    `)
    // Migration: add columns missing from older databases. A fresh table already has
    // them, so ALTER throws "duplicate column name" — swallow only that; surface any other
    // failure instead of starting with a broken schema. Schema setup is synchronous now,
    // so the DB is ready by the time the constructor returns.
    for (const column of [
      'label TEXT',
      'serviceId TEXT',
      'quotaBytes INTEGER',
      'expiresAt INTEGER'
    ]) {
      try {
        this.db.exec(`ALTER TABLE persistent_storage_buckets ADD COLUMN ${column}`)
      } catch (alterErr) {
        if (!/duplicate column name/i.test(alterErr.message)) {
          throw alterErr
        }
      }
    }
    // At most one auto-created bucket per service, so a retried start can't make two.
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_persistent_storage_buckets_serviceId
      ON persistent_storage_buckets (serviceId) WHERE serviceId IS NOT NULL;
    `)
    this.dbReady = true
    this.dbReadyPromise = Promise.resolve()
  }

  public isDbReady(): boolean {
    return this.dbReady
  }

  private async ensureDbReady(): Promise<void> {
    if (this.dbReady) {
      return
    }
    await this.dbReadyPromise
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
    label?: string,
    options?: CreateBucketOptions
  ): Promise<CreateBucketResult>

  /** Removes the bucket's contents and its registry row. */
  public abstract deleteBucket(bucketId: string): Promise<void>

  /** Total bytes stored in the bucket, including nested folders a container wrote. */
  public abstract getBucketUsageBytes(bucketId: string): Promise<number>

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
   * Lists buckets for a given owner from the SQLite registry (metadata only).
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
      label: row.label ?? null,
      serviceId: row.serviceId ?? null,
      quotaBytes: row.quotaBytes ?? null,
      expiresAt: row.expiresAt ?? null
    }))
  }

  /**
   * Returns the output bucket auto-created for `serviceId`, creating it on first call:
   * owned by `owner`, no access list, SERVICE_BUCKET_QUOTA_BYTES quota, and kept for
   * SERVICE_BUCKET_RETENTION_SECONDS past the service's paid window (both env vars, 5 GB and
   * 1 week by default). Idempotent per
   * serviceId — a second call returns the same bucket with its retention extended.
   */
  async getOrCreateServiceBucket(
    owner: string,
    serviceId: string,
    serviceExpiresAtMs: number
  ): Promise<BucketRow> {
    const existing = await this.dbGetBucketByServiceId(serviceId)
    if (existing) {
      await this.extendBucketRetention(existing.bucketId, serviceExpiresAtMs)
      return (await this.dbGetBucket(existing.bucketId)) ?? existing
    }
    const { bucketId } = await this.createNewBucket([], owner, `service-${serviceId}`, {
      serviceId,
      quotaBytes: this.serviceBucketQuotaBytes(),
      expiresAt: this.serviceBucketExpiryFor(serviceExpiresAtMs)
    })
    return await this.dbGetBucket(bucketId)
  }

  /**
   * Keeps an expiring bucket alive until SERVICE_BUCKET_RETENTION_SECONDS after the given
   * service window ends. Never shortens it, and leaves buckets without an expiry alone.
   */
  async extendBucketRetention(
    bucketId: string,
    serviceExpiresAtMs: number
  ): Promise<void> {
    const sql = `UPDATE persistent_storage_buckets SET expiresAt = MAX(expiresAt, ?) WHERE bucketId = ? AND expiresAt IS NOT NULL`
    await this.ensureDbReady()
    this.db.run(sql, [this.serviceBucketExpiryFor(serviceExpiresAtMs), bucketId])
  }

  // Default output bucket SERVICE_START creates when the request carries no outputBucketId.
  // Buckets created any other way have neither a quota nor an expiry. The quota is stamped
  // on the bucket at creation, so changing the env var only affects new buckets.
  serviceBucketQuotaBytes(): number {
    return (
      this.node.getConfig().serviceBucketQuotaBytes ?? DEFAULT_SERVICE_BUCKET_QUOTA_BYTES
    )
  }

  // Retention counts from the END of the paid service window (expiresAt), not from creation:
  // a Stopped service stays restartable until expiresAt, and its results must outlive it.
  serviceBucketExpiryFor(serviceExpiresAtMs: number): number {
    const retention =
      this.node.getConfig().serviceBucketRetentionSeconds ??
      DEFAULT_SERVICE_BUCKET_RETENTION_SECONDS
    return Math.floor(serviceExpiresAtMs / 1000) + retention
  }

  /**
   * Quota and current usage of a bucket, or null when the bucket has no quota. Sizing walks
   * the whole bucket folder, so a caller that polls (service status) can accept a reading
   * up to `maxAgeMs` old. Uploads and deletes through this API drop the cached reading;
   * writes a service container makes show up once it ages out.
   */
  async getBucketQuotaUsage(
    bucketId: string,
    maxAgeMs = 0
  ): Promise<{ quotaBytes: number; usedBytes: number } | null> {
    const bucket = await this.getBucket(bucketId)
    if (!bucket || bucket.quotaBytes === null || bucket.quotaBytes === undefined) {
      return null
    }
    const cached = this.bucketUsageCache.get(bucketId)
    if (maxAgeMs > 0 && cached && Date.now() - cached.at <= maxAgeMs) {
      return { quotaBytes: bucket.quotaBytes, usedBytes: cached.usedBytes }
    }
    const usedBytes = await this.getBucketUsageBytes(bucketId)
    this.bucketUsageCache.set(bucketId, { usedBytes, at: Date.now() })
    return { quotaBytes: bucket.quotaBytes, usedBytes }
  }

  /** Drops the cached size of a bucket after its contents changed. */
  protected forgetBucketUsage(bucketId: string): void {
    this.bucketUsageCache.delete(bucketId)
  }

  /** Deletes every bucket whose expiry has passed. Returns how many were removed. */
  async deleteExpiredBuckets(
    nowSeconds = Math.floor(Date.now() / 1000)
  ): Promise<number> {
    const sql = `SELECT ${BUCKET_COLUMNS} FROM persistent_storage_buckets WHERE expiresAt IS NOT NULL AND expiresAt <= ?`
    await this.ensureDbReady()
    const expired = this.db.all<BucketRow>(sql, [nowSeconds])
    let deleted = 0
    for (const bucket of expired) {
      try {
        await this.deleteBucket(bucket.bucketId)
        deleted++
      } catch (e) {
        // Left in place: the next sweep retries it.
        CORE_LOGGER.error(
          `Could not delete expired bucket ${bucket.bucketId}: ${e?.message ?? e}`
        )
      }
    }
    return deleted
  }

  /*
   * NOTE: db* methods are intentionally gated on ensureDbReady() to avoid races
   * with constructor-time schema creation.
   */

  async dbUpsertBucket(
    bucketId: string,
    owner: string,
    accessListJson: string,
    createdAt: number,
    label: string | null,
    options: CreateBucketOptions = {}
  ): Promise<void> {
    // ON CONFLICT does not touch label, so a re-create never clobbers a rename.
    const sql = `
      INSERT INTO persistent_storage_buckets (${BUCKET_COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucketId) DO UPDATE SET accessListJson=excluded.accessListJson;
    `
    await this.ensureDbReady()
    this.db.run(sql, [
      bucketId,
      owner,
      accessListJson,
      createdAt,
      label,
      options.serviceId ?? null,
      options.quotaBytes ?? null,
      options.expiresAt ?? null
    ])
  }

  async dbGetBucket(bucketId: string): Promise<BucketRow | null> {
    const sql = `SELECT ${BUCKET_COLUMNS} FROM persistent_storage_buckets WHERE bucketId = ?`
    await this.ensureDbReady()
    const row = this.db.get<BucketRow>(sql, [bucketId])
    return row ?? null
  }

  async dbGetBucketByServiceId(serviceId: string): Promise<BucketRow | null> {
    const sql = `SELECT ${BUCKET_COLUMNS} FROM persistent_storage_buckets WHERE serviceId = ?`
    await this.ensureDbReady()
    const row = this.db.get<BucketRow>(sql, [serviceId])
    return row ?? null
  }

  async dbListBucketsByOwner(owner: string): Promise<BucketRow[]> {
    const sql = `SELECT ${BUCKET_COLUMNS} FROM persistent_storage_buckets WHERE owner = ? ORDER BY createdAt ASC`
    await this.ensureDbReady()
    return this.db.all<BucketRow>(sql, [owner])
  }

  async dbDeleteBucket(bucketId: string): Promise<boolean> {
    const sql = `DELETE FROM persistent_storage_buckets WHERE bucketId = ?`
    await this.ensureDbReady()
    const { changes } = this.db.run(sql, [bucketId])
    return changes === 1
  }

  async dbUpdateBucketLabel(
    bucketId: string,
    owner: string,
    label: string | null
  ): Promise<boolean> {
    const sql = `UPDATE persistent_storage_buckets SET label = ? WHERE bucketId = ? AND owner = ?`
    await this.ensureDbReady()
    const { changes } = this.db.run(sql, [label, bucketId, owner])
    return changes === 1
  }

  isAllowed(consumerAddress: string, accessLists: AccessList[]): Promise<boolean> {
    return checkAddressOnAccessList(consumerAddress, accessLists, this.node)
  }

  /** Throws {@link PersistentStorageAccessDeniedError} if the consumer is not on the bucket access list. */
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
