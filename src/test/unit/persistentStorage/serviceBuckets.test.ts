import { expect } from 'chai'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { PersistentStorageLocalFS } from '../../../components/persistentStorage/PersistentStorageLocalFS.js'
import { PersistentStorageQuotaExceededError } from '../../../components/persistentStorage/PersistentStorageFactory.js'
import {
  DEFAULT_SERVICE_BUCKET_QUOTA_BYTES,
  DEFAULT_SERVICE_BUCKET_RETENTION_SECONDS
} from '../../../utils/config/constants.js'

const OWNER = '0x0000000000000000000000000000000000000aBc'

describe('Service output buckets (localfs)', () => {
  let folder: string
  let storage: PersistentStorageLocalFS

  before(async () => {
    folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'ps-service-buckets-'))
    const node: any = {
      getConfig: () => ({
        persistentStorage: { enabled: true, type: 'localfs', options: { folder } }
      })
    }
    storage = new PersistentStorageLocalFS(node)
  })

  after(async () => {
    await fsp.rm(folder, { recursive: true, force: true })
  })

  // The registry DB is shared across runs, so every test uses a fresh serviceId.
  const newServiceId = () => `svc-${randomUUID()}`

  it('creates a bucket owned by the consumer, with no access list, the 5 GB quota and a week of retention', async () => {
    const serviceExpiresAt = Date.now() + 3600_000
    const bucket = await storage.getOrCreateServiceBucket(
      OWNER,
      newServiceId(),
      serviceExpiresAt
    )
    expect(bucket.owner).to.equal(OWNER)
    expect(JSON.parse(bucket.accessListJson)).to.deep.equal([])
    expect(bucket.quotaBytes).to.equal(DEFAULT_SERVICE_BUCKET_QUOTA_BYTES)
    expect(bucket.expiresAt).to.equal(
      Math.floor(serviceExpiresAt / 1000) + DEFAULT_SERVICE_BUCKET_RETENTION_SECONDS
    )
    const st = await fsp.stat(path.join(folder, 'buckets', bucket.bucketId))
    expect(st.isDirectory()).to.equal(true)
  })

  it('takes the quota and retention from config when set', async () => {
    const node: any = {
      getConfig: () => ({
        persistentStorage: { enabled: true, type: 'localfs', options: { folder } },
        serviceBucketQuotaBytes: 1024,
        serviceBucketRetentionSeconds: 60
      })
    }
    const configured = new PersistentStorageLocalFS(node)
    const serviceExpiresAt = Date.now() + 3600_000
    const bucket = await configured.getOrCreateServiceBucket(
      OWNER,
      newServiceId(),
      serviceExpiresAt
    )
    expect(bucket.quotaBytes).to.equal(1024)
    expect(bucket.expiresAt).to.equal(Math.floor(serviceExpiresAt / 1000) + 60)
  })

  it('is idempotent per serviceId and only ever extends the retention', async () => {
    const serviceId = newServiceId()
    const t = Date.now() + 3600_000
    const first = await storage.getOrCreateServiceBucket(OWNER, serviceId, t)
    const later = await storage.getOrCreateServiceBucket(OWNER, serviceId, t + 7200_000)
    expect(later.bucketId).to.equal(first.bucketId)
    expect(later.expiresAt).to.equal(first.expiresAt + 7200)
    // an earlier window never shortens it
    await storage.extendBucketRetention(first.bucketId, t)
    expect((await storage.getBucket(first.bucketId)).expiresAt).to.equal(later.expiresAt)
  })

  it('never gives an expiry to a bucket created without one', async () => {
    const { bucketId } = await storage.createNewBucket([], OWNER)
    await storage.extendBucketRetention(bucketId, Date.now())
    const row = await storage.getBucket(bucketId)
    expect(row.expiresAt).to.equal(null)
    expect(row.quotaBytes).to.equal(null)
    expect(await storage.getBucketQuotaUsage(bucketId)).to.equal(null)
  })

  it('counts files in nested folders towards usage', async () => {
    const bucket = await storage.getOrCreateServiceBucket(
      OWNER,
      newServiceId(),
      Date.now()
    )
    const dir = path.join(folder, 'buckets', bucket.bucketId)
    await fsp.mkdir(path.join(dir, 'a', 'b'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'top.txt'), Buffer.alloc(10))
    await fsp.writeFile(path.join(dir, 'a', 'b', 'deep.bin'), Buffer.alloc(25))
    expect(await storage.getBucketUsageBytes(bucket.bucketId)).to.equal(35)
  })

  describe('quota', () => {
    let bucketId: string

    beforeEach(async () => {
      ;({ bucketId } = await storage.createNewBucket([], OWNER, undefined, {
        quotaBytes: 100
      }))
    })

    it('accepts an upload that fits', async () => {
      const info = await storage.uploadFile(
        bucketId,
        'ok.bin',
        Readable.from([Buffer.alloc(100)]),
        OWNER
      )
      expect(info.size).to.equal(100)
      // full now: the next upload is refused
      await storage
        .uploadFile(bucketId, 'more.bin', Readable.from([Buffer.alloc(1)]), OWNER)
        .then(
          () => expect.fail('a full bucket must refuse uploads'),
          (e) => expect(e).to.be.instanceOf(PersistentStorageQuotaExceededError)
        )
    })

    it('accepts uploads again once files are deleted', async () => {
      await storage.uploadFile(
        bucketId,
        'a.bin',
        Readable.from([Buffer.alloc(100)]),
        OWNER
      )
      // warm the cache with the full reading, as a status poll would
      expect((await storage.getBucketQuotaUsage(bucketId, 60_000)).usedBytes).to.equal(
        100
      )
      await storage.deleteFile(bucketId, 'a.bin', OWNER)
      expect((await storage.getBucketQuotaUsage(bucketId, 60_000)).usedBytes).to.equal(0)
      const info = await storage.uploadFile(
        bucketId,
        'b.bin',
        Readable.from([Buffer.alloc(50)]),
        OWNER
      )
      expect(info.size).to.equal(50)
    })

    it('serves a cached reading within maxAgeMs and re-sizes after it', async () => {
      const dir = path.join(folder, 'buckets', bucketId)
      expect((await storage.getBucketQuotaUsage(bucketId, 60_000)).usedBytes).to.equal(0)
      // a write the storage API never saw, as a service container makes
      await fsp.writeFile(path.join(dir, 'from-container.bin'), Buffer.alloc(40))
      expect((await storage.getBucketQuotaUsage(bucketId, 60_000)).usedBytes).to.equal(0)
      expect((await storage.getBucketQuotaUsage(bucketId)).usedBytes).to.equal(40)
    })

    it('rejects an upload that overflows and leaves no partial file behind', async () => {
      await storage
        .uploadFile(bucketId, 'big.bin', Readable.from([Buffer.alloc(101)]), OWNER)
        .then(
          () => expect.fail('upload should be rejected'),
          (e) => expect(e).to.be.instanceOf(PersistentStorageQuotaExceededError)
        )
      expect(await storage.getBucketUsageBytes(bucketId)).to.equal(0)
    })

    it('frees the size of the file an upload replaces, and keeps it when the upload fails', async () => {
      await storage.uploadFile(
        bucketId,
        'f.bin',
        Readable.from([Buffer.alloc(80)]),
        OWNER
      )
      // 80 in use, but replacing f.bin frees those 80 bytes
      await storage.uploadFile(
        bucketId,
        'f.bin',
        Readable.from([Buffer.alloc(90)]),
        OWNER
      )
      await storage
        .uploadFile(bucketId, 'f.bin', Readable.from([Buffer.alloc(150)]), OWNER)
        .catch(() => {})
      const files = await storage.listFiles(bucketId, OWNER)
      expect(files.map((f) => [f.name, f.size])).to.deep.equal([['f.bin', 90]])
    })
  })

  it('deletes expired buckets and keeps the rest', async () => {
    const expired = await storage.getOrCreateServiceBucket(
      OWNER,
      newServiceId(),
      Date.now() - (DEFAULT_SERVICE_BUCKET_RETENTION_SECONDS + 60) * 1000
    )
    const live = await storage.getOrCreateServiceBucket(OWNER, newServiceId(), Date.now())
    const permanent = await storage.createNewBucket([], OWNER)

    expect(await storage.deleteExpiredBuckets()).to.be.greaterThanOrEqual(1)

    expect(await storage.getBucket(expired.bucketId)).to.equal(null)
    await fsp.stat(path.join(folder, 'buckets', expired.bucketId)).then(
      () => expect.fail('expired bucket folder should be gone'),
      (e) => expect(e.code).to.equal('ENOENT')
    )
    expect(await storage.getBucket(live.bucketId)).to.not.equal(null)
    expect(await storage.getBucket(permanent.bucketId)).to.not.equal(null)
  })
})
