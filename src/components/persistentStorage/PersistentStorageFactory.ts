import { P2PCommandResponse } from '../../@types/index.js'
import type { AccessList } from '../../@types/AccessList.js'
import type {
  DockerMountObject,
  PersistentStorageObject
} from '../../@types/PersistentStorage.js'

import sqlite3, { RunResult } from 'sqlite3'
import path from 'path'
import fs from 'fs'
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

export type BucketRow = {
  bucketId: string
  owner: string
  accessListJson: string
  createdAt: number
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
}

/** Bucket metadata from registry (list APIs and internal filtering). */
export type PersistentStorageBucketRecord = {
  bucketId: string
  owner: string
  createdAt: number
  accessLists: AccessList[]
}

export abstract class PersistentStorageFactory {
  private db: sqlite3.Database
  private node: OceanNode
  private dbReady = false
  private dbReadyPromise: Promise<void>

  constructor(node: OceanNode) {
    this.node = node
    const dbDir = path.dirname('databases/persistentStorage.sqlite')
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    this.db = new sqlite3.Database('databases/persistentStorage.sqlite')
    const createBucketsSQL = `
      CREATE TABLE IF NOT EXISTS persistent_storage_buckets (
        bucketId TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        accessListJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `
    this.dbReadyPromise = new Promise<void>((resolve, reject) => {
      this.db.run(createBucketsSQL, (err) => {
        if (err) {
          reject(err)
          return
        }
        this.dbReady = true
        resolve()
      })
    })
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
    owner: string
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
    consumerAddress?: string
  ): Promise<DockerMountObject>

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
      accessLists: parseBucketAccessListsJson(row.accessListJson)
    }))
  }

  /*
   * NOTE: db* methods are intentionally gated on ensureDbReady() to avoid races
   * with constructor-time schema creation.
   */

  dbUpsertBucket(
    bucketId: string,
    owner: string,
    accessListJson: string,
    createdAt: number
  ): Promise<void> {
    const sql = `
      INSERT INTO persistent_storage_buckets (bucketId, owner, accessListJson, createdAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(bucketId) DO UPDATE SET accessListJson=excluded.accessListJson;
    `
    return this.ensureDbReady().then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.db.run(sql, [bucketId, owner, accessListJson, createdAt], (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
    )
  }

  dbGetBucket(bucketId: string): Promise<BucketRow | null> {
    const sql = `SELECT bucketId, owner, accessListJson, createdAt FROM persistent_storage_buckets WHERE bucketId = ?`
    return this.ensureDbReady().then(
      () =>
        new Promise((resolve, reject) => {
          this.db.get(sql, [bucketId], (err, row: BucketRow | undefined) => {
            if (err) reject(err)
            else resolve(row ?? null)
          })
        })
    )
  }

  dbListBucketsByOwner(owner: string): Promise<BucketRow[]> {
    const sql = `SELECT bucketId, owner, accessListJson, createdAt FROM persistent_storage_buckets WHERE owner = ? ORDER BY createdAt ASC`
    return this.ensureDbReady().then(
      () =>
        new Promise((resolve, reject) => {
          this.db.all(sql, [owner], (err, rows: BucketRow[]) => {
            if (err) reject(err)
            else resolve(rows ?? [])
          })
        })
    )
  }

  dbDeleteBucket(bucketId: string): Promise<boolean> {
    const sql = `DELETE FROM persistent_storage_buckets WHERE bucketId = ?`
    return this.ensureDbReady().then(
      () =>
        new Promise((resolve, reject) => {
          this.db.run(sql, [bucketId], function (this: RunResult, err) {
            if (err) reject(err)
            else resolve(this.changes === 1)
          })
        })
    )
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
}

/**
 * Algorithms must not reference node persistent storage; only datasets may use
 * `nodePersistentStorage` / `localfs` file objects.
 */
export function rejectPersistentStorageFileObjectOnAlgorithm(
  fileObject: unknown
): P2PCommandResponse | null {
  if (fileObject === null || fileObject === undefined || typeof fileObject !== 'object') {
    return null
  }
  const fo = fileObject as { type?: string }
  if (fo.type === 'nodePersistentStorage' || fo.type === 'localfs') {
    return {
      stream: null,
      status: {
        httpStatus: 400,
        error:
          'Algorithms cannot use node persistent storage file objects; only datasets may reference persistent storage.'
      }
    }
  }
  return null
}

/**
 * When a compute dataset uses a node persistent-storage file (localfs backend),
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
  if (fo.type !== 'nodePersistentStorage') {
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
