export type BucketRow = {
  bucketId: string
  owner: string
  accessListJson: string
  createdAt: number
  label: string | null
}

// persistent-storage bucket metadata; the bucket files live in the storage backend
export interface BucketRegistry {
  // a conflict updates accessListJson only, so a re-create never clobbers a rename
  upsertBucket(
    bucketId: string,
    owner: string,
    accessListJson: string,
    createdAt: number,
    label: string | null
  ): Promise<void>
  getBucket(bucketId: string): Promise<BucketRow | null>
  // exact owner match, createdAt ascending
  listBucketsByOwner(owner: string): Promise<BucketRow[]>
  deleteBucket(bucketId: string): Promise<boolean>
  // false when the bucket is unknown or the owner does not match
  updateBucketLabel(
    bucketId: string,
    owner: string,
    label: string | null
  ): Promise<boolean>
}
