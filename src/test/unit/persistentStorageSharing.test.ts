import { expect } from 'chai'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { Wallet } from 'ethers'
import { Client } from '@elastic/elasticsearch'

import type { OceanNode } from '../../OceanNode.js'
import type { AccessList } from '../../@types/AccessList.js'
import { PersistentStorageLocalFS } from '../../components/persistentStorage/PersistentStorageLocalFS.js'
import { PersistentStorageAccessDeniedError } from '../../components/persistentStorage/PersistentStorageFactory.js'
import { ElasticsearchBucketRegistry } from '../../components/database/ElasticsearchBucketRegistry.js'
import { createElasticsearchClientWithRetry } from '../../components/database/ElasticsearchConfigHelper.js'
import { getConfiguration } from '../../utils/index.js'

let registry: ElasticsearchBucketRegistry
let esClient: Client

async function wipeBuckets(): Promise<void> {
  await esClient.deleteByQuery({
    index: 'buckets',
    query: { match_all: {} },
    refresh: true,
    conflicts: 'proceed'
  })
}

async function initRegistry(): Promise<void> {
  if (registry) return
  const { dbConfig } = await getConfiguration()
  registry = await ElasticsearchBucketRegistry.create(dbConfig)
  esClient = await createElasticsearchClientWithRetry(dbConfig)
}

describe('Persistent storage bucket sharing toggle', () => {
  const owner = Wallet.createRandom().address
  const other = Wallet.createRandom().address
  const bucketAcl: AccessList[] = [{ '8996': [Wallet.createRandom().address] }]

  let folder: string
  let allowBucketSharing: boolean | undefined
  let aclChecks: number
  let backend: PersistentStorageLocalFS
  let bucketId: string
  let secondSharedBucketId: string
  let privateBucketId: string

  before(async () => {
    await initRegistry()
    // buckets are created once for the whole suite, so wipe before, not beforeEach
    await wipeBuckets()
    folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'ocean-ps-sharing-'))
    const fakeNode = {
      getConfig: () => ({
        persistentStorage: {
          enabled: true,
          type: 'localfs',
          accessLists: [] as AccessList[],
          allowBucketSharing,
          options: { folder }
        }
      })
    } as unknown as OceanNode
    backend = new PersistentStorageLocalFS(fakeNode, registry)
    // Stand-in for the on-chain access list check: every address is on any non-empty ACL
    // (like the real check, an empty ACL lets nobody in).
    backend.isAllowed = (_consumer, accessLists) => {
      aclChecks++
      return Promise.resolve(accessLists.length > 0)
    }
    ;({ bucketId } = await backend.createNewBucket(bucketAcl, owner))
    ;({ bucketId: secondSharedBucketId } = await backend.createNewBucket(
      bucketAcl,
      owner
    ))
    ;({ bucketId: privateBucketId } = await backend.createNewBucket([], owner))
  })

  beforeEach(() => {
    aclChecks = 0
  })

  after(async () => {
    await fsp.rm(folder, { recursive: true, force: true })
  })

  it('disables sharing by default', async () => {
    allowBucketSharing = undefined
    expect(backend.isBucketSharingAllowed()).to.equal(false)
    let error: unknown
    try {
      await backend.assertConsumerAllowedForBucket(other, bucketId)
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(PersistentStorageAccessDeniedError)
    expect(aclChecks).to.equal(0)
  })

  it('lets a consumer on the bucket access list in when sharing is enabled', async () => {
    allowBucketSharing = true
    await backend.assertConsumerAllowedForBucket(other, bucketId)
    expect(aclChecks).to.equal(1)
  })

  it('denies a consumer on the bucket access list when sharing is disabled', async () => {
    allowBucketSharing = false
    expect(backend.isBucketSharingAllowed()).to.equal(false)
    let error: unknown
    try {
      await backend.assertConsumerAllowedForBucket(other, bucketId)
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(PersistentStorageAccessDeniedError)
    expect(aclChecks).to.equal(0)
  })

  it('still lets the owner in when sharing is disabled', async () => {
    allowBucketSharing = false
    await backend.assertConsumerAllowedForBucket(owner, bucketId)
    await backend.listFiles(bucketId, owner)
    expect(aclChecks).to.equal(0)
  })

  const listedIds = async (consumer: string) =>
    (await backend.listBucketsForConsumer(owner, consumer)).map((b) => b.bucketId)

  it('lists all buckets to the owner', async () => {
    allowBucketSharing = true
    expect(await listedIds(owner)).to.have.members([
      bucketId,
      secondSharedBucketId,
      privateBucketId
    ])
    expect(aclChecks).to.equal(0)
  })

  it('lists only buckets shared with a non-owner, checking each access list once', async () => {
    allowBucketSharing = true
    expect(await listedIds(other)).to.have.members([bucketId, secondSharedBucketId])
    // two distinct access lists (bucketAcl and []) across three buckets
    expect(aclChecks).to.equal(2)
  })

  it('lists nothing to a non-owner when sharing is disabled', async () => {
    allowBucketSharing = false
    expect(await listedIds(other)).to.deep.equal([])
    expect(await listedIds(owner)).to.have.lengthOf(3)
    expect(aclChecks).to.equal(0)
  })
})

describe('Elasticsearch bucket registry', () => {
  const owner = Wallet.createRandom().address

  before(initRegistry)
  beforeEach(wipeBuckets)

  it('returns an upserted bucket and null for an unknown one', async () => {
    await registry.upsertBucket('b1', owner, '[]', 100, 'first')
    expect(await registry.getBucket('b1')).to.deep.equal({
      bucketId: 'b1',
      owner,
      accessListJson: '[]',
      createdAt: 100,
      label: 'first'
    })
    expect(await registry.getBucket('missing')).to.equal(null)
  })

  it('re-upsert updates the access list only and keeps the old label', async () => {
    await registry.upsertBucket('b1', owner, '[]', 100, 'first')
    await registry.upsertBucket('b1', owner, '[{"1":["0xabc"]}]', 200, 'second')
    const row = await registry.getBucket('b1')
    expect(row.accessListJson).to.equal('[{"1":["0xabc"]}]')
    expect(row.label).to.equal('first')
    expect(row.createdAt).to.equal(100)
  })

  it('lists buckets by exact owner, oldest first', async () => {
    await registry.upsertBucket('late', owner, '[]', 300, null)
    await registry.upsertBucket('early', owner, '[]', 100, null)
    await registry.upsertBucket('other', Wallet.createRandom().address, '[]', 200, null)
    const rows = await registry.listBucketsByOwner(owner)
    expect(rows.map((r) => r.bucketId)).to.deep.equal(['early', 'late'])
    expect(await registry.listBucketsByOwner(owner.toLowerCase())).to.deep.equal([])
  })

  it('deletes a bucket once', async () => {
    await registry.upsertBucket('b1', owner, '[]', 100, null)
    expect(await registry.deleteBucket('b1')).to.equal(true)
    expect(await registry.deleteBucket('b1')).to.equal(false)
    expect(await registry.getBucket('b1')).to.equal(null)
  })

  it('updates the label only for the owner', async () => {
    await registry.upsertBucket('b1', owner, '[]', 100, 'first')
    const stranger = Wallet.createRandom().address
    expect(await registry.updateBucketLabel('b1', stranger, 'hacked')).to.equal(false)
    expect(await registry.updateBucketLabel('missing', owner, 'x')).to.equal(false)
    expect(await registry.updateBucketLabel('b1', owner, null)).to.equal(true)
    expect((await registry.getBucket('b1')).label).to.equal(null)
  })
})
