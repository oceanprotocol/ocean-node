import type { BucketRegistry, BucketRow } from '../BucketRegistry.js'
import type { SqlClient } from './SqlClient.js'

const COLUMNS = '"bucketId", "owner", "accessListJson", "createdAt", "label"'

// one row per persistent-storage bucket
export class SqlBucketRegistry implements BucketRegistry {
  constructor(private db: SqlClient) {}

  init(): Promise<void> {
    return this.db.exec(`
      CREATE TABLE IF NOT EXISTS persistent_storage_buckets (
        "bucketId" TEXT PRIMARY KEY,
        "owner" TEXT NOT NULL,
        "accessListJson" TEXT NOT NULL,
        "createdAt" BIGINT NOT NULL,
        "label" TEXT
      )`)
  }

  // a conflict changes the access list only, so a second create never removes a new name
  async upsertBucket(
    bucketId: string,
    owner: string,
    accessListJson: string,
    createdAt: number,
    label: string | null
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO persistent_storage_buckets (${COLUMNS}) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT ("bucketId") DO UPDATE SET "accessListJson" = excluded."accessListJson"`,
      [bucketId, owner, accessListJson, createdAt, label]
    )
  }

  async getBucket(bucketId: string): Promise<BucketRow | null> {
    const row = await this.db.get<BucketRow>(
      `SELECT ${COLUMNS} FROM persistent_storage_buckets WHERE "bucketId" = ?`,
      [bucketId]
    )
    return row ?? null
  }

  listBucketsByOwner(owner: string): Promise<BucketRow[]> {
    return this.db.all<BucketRow>(
      `SELECT ${COLUMNS} FROM persistent_storage_buckets
       WHERE "owner" = ? ORDER BY "createdAt" ASC`,
      [owner]
    )
  }

  async deleteBucket(bucketId: string): Promise<boolean> {
    const { changes } = await this.db.run(
      'DELETE FROM persistent_storage_buckets WHERE "bucketId" = ?',
      [bucketId]
    )
    return changes === 1
  }

  async updateBucketLabel(
    bucketId: string,
    owner: string,
    label: string | null
  ): Promise<boolean> {
    const { changes } = await this.db.run(
      'UPDATE persistent_storage_buckets SET "label" = ? WHERE "bucketId" = ? AND "owner" = ?',
      [label, bucketId, owner]
    )
    return changes === 1
  }
}
