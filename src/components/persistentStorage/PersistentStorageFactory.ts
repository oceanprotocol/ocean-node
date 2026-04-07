import type { AccessList } from '../../@types/AccessList.js'
import type { BaseFileObject } from '../../@types/fileObject.js'
import sqlite3, { RunResult } from 'sqlite3'
import path from 'path'
import fs from 'fs'
import { OceanNode } from '../../OceanNode.js'
import { checkAddressOnAccessList } from '../../utils/accessList.js'

export class PersistentStorageAccessDeniedError extends Error {
  constructor(message = 'You are not allowed to access this bucket') {
    super(message)
    this.name = 'PersistentStorageAccessDeniedError'
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

  constructor(node: OceanNode) {
    this.node = node
    const dbDir = path.dirname('databases/')
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    this.db = new sqlite3.Database(dbDir + 'persistentStorage.sqlite')
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
  ): Promise<BaseFileObject>

  // common functions
  async getBucketAccessList(bucketId: string): Promise<AccessList[]> {
    await this.dbCreateTables()
    try {
      const row = await this.dbGetBucket(bucketId)
      if (!row) {
        return []
      }
      return parseBucketAccessListsJson(row.accessListJson)
    } catch {
      return []
    }
  }

  /**
   * Lists buckets for a given owner from the SQLite registry (metadata only).
   * `owner` must already be normalized (e.g. checksummed `getAddress`).
   * Backends that need setup (e.g. localfs init) should override and call `super.listBuckets(owner)`.
   */
  async listBuckets(owner: string): Promise<PersistentStorageBucketRecord[]> {
    await this.dbCreateTables()
    const rows = await this.dbListBucketsByOwner(owner)
    return rows.map((row) => ({
      bucketId: row.bucketId,
      owner: row.owner,
      createdAt: row.createdAt,
      accessLists: parseBucketAccessListsJson(row.accessListJson)
    }))
  }

  dbCreateTables(): Promise<void> {
    const createBucketsSQL = `
      CREATE TABLE IF NOT EXISTS persistent_storage_buckets (
        bucketId TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        accessListJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `
    return new Promise<void>((resolve, reject) => {
      this.db.run(createBucketsSQL, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

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
    return new Promise<void>((resolve, reject) => {
      this.db.run(sql, [bucketId, owner, accessListJson, createdAt], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  dbGetBucket(bucketId: string): Promise<BucketRow | null> {
    const sql = `SELECT bucketId, owner, accessListJson, createdAt FROM persistent_storage_buckets WHERE bucketId = ?`
    return new Promise((resolve, reject) => {
      this.db.get(sql, [bucketId], (err, row: BucketRow | undefined) => {
        if (err) reject(err)
        else resolve(row ?? null)
      })
    })
  }

  dbListBucketsByOwner(owner: string): Promise<BucketRow[]> {
    const sql = `SELECT bucketId, owner, accessListJson, createdAt FROM persistent_storage_buckets WHERE owner = ? ORDER BY createdAt ASC`
    return new Promise((resolve, reject) => {
      this.db.all(sql, [owner], (err, rows: BucketRow[]) => {
        if (err) reject(err)
        else resolve(rows ?? [])
      })
    })
  }

  dbDeleteBucket(bucketId: string): Promise<boolean> {
    const sql = `DELETE FROM persistent_storage_buckets WHERE bucketId = ?`
    return new Promise((resolve, reject) => {
      this.db.run(sql, [bucketId], function (this: RunResult, err) {
        if (err) reject(err)
        else resolve(this.changes === 1)
      })
    })
  }

  isAllowed(consumerAddress: string, accessLists: AccessList[]): Promise<boolean> {
    return checkAddressOnAccessList(consumerAddress, accessLists, this.node)
  }

  /** Throws {@link PersistentStorageAccessDeniedError} if the consumer is not on the bucket access list. */
  protected async assertConsumerAllowedForBucket(
    consumerAddress: string,
    bucketId: string
  ): Promise<void> {
    const accessLists = await this.getBucketAccessList(bucketId)
    if (!(await this.isAllowed(consumerAddress, accessLists))) {
      throw new PersistentStorageAccessDeniedError()
    }
  }
}
