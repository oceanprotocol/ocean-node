import { expect } from 'chai'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { Wallet } from 'ethers'

import type { OceanNode } from '../../OceanNode.js'
import type { AccessList } from '../../@types/AccessList.js'
import { PersistentStorageLocalFS } from '../../components/persistentStorage/PersistentStorageLocalFS.js'
import { PersistentStorageAccessDeniedError } from '../../components/persistentStorage/PersistentStorageFactory.js'

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
    backend = new PersistentStorageLocalFS(fakeNode)
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
