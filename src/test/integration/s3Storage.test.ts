/**
 * S3 Storage integration tests against Ceph RGW (or any S3-compatible endpoint).
 *
 * Prerequisites:
 * - Ceph RGW (or compatible) running, e.g. at http://172.15.0.7:7480
 * - Environment variables set:
 *   - S3_TEST_ENDPOINT (optional, default: http://172.15.0.7:7480)
 *   - S3_TEST_ACCESS_KEY_ID
 *   - S3_TEST_SECRET_ACCESS_KEY
 *   - S3_TEST_BUCKET
 *
 * The test creates the bucket if missing, puts a temporary object, then removes the object in after().
 * If credentials are missing or setup fails (endpoint unreachable, auth failure), the suite is skipped.
 */

import { expect } from 'chai'
import { Readable } from 'stream'
import { Storage, S3Storage } from '../../components/storage/index.js'
import { getConfiguration } from '../../utils/index.js'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { FileInfoRequest, FileObjectType } from '../../@types/fileObject.js'
import { DEFAULT_TEST_TIMEOUT } from '../utils/utils.js'

const S3_TEST_ENDPOINT = 'http://172.15.0.7:7480'
const S3_TEST_ACCESS_KEY_ID = 'ocean123'
const S3_TEST_SECRET_ACCESS_KEY = 'ocean123secret'
const S3_TEST_BUCKET = 'testbucket'
const TEST_OBJECT_KEY = 'integration-test/hello.txt'
const TEST_BODY = 'Hello S3 from integration test'

function canRunS3Tests(): boolean {
  return Boolean(S3_TEST_ACCESS_KEY_ID && S3_TEST_SECRET_ACCESS_KEY && S3_TEST_BUCKET)
}

function createTestS3Client(): S3Client {
  return new S3Client({
    endpoint: S3_TEST_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3_TEST_ACCESS_KEY_ID!,
      secretAccessKey: S3_TEST_SECRET_ACCESS_KEY!
    }
  })
}

describe('S3 Storage integration (Ceph RGW)', function () {
  this.timeout(DEFAULT_TEST_TIMEOUT)

  let config: Awaited<ReturnType<typeof getConfiguration>>
  let s3Client: S3Client
  let objectCreated = false

  before(async function () {
    if (!canRunS3Tests()) {
      this.skip()
      return
    }
    config = await getConfiguration()
    s3Client = createTestS3Client()
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: S3_TEST_BUCKET! }))
    } catch (err: any) {
      const alreadyExists =
        err.name === 'BucketAlreadyExists' ||
        err.Code === 'BucketAlreadyExists' ||
        err.Code === 'BucketAlreadyOwnedByYou' ||
        err.$metadata?.httpStatusCode === 409
      if (!alreadyExists) {
        this.skip()
        return
      }
    }
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: S3_TEST_BUCKET,
          Key: TEST_OBJECT_KEY,
          Body: TEST_BODY,
          ContentType: 'text/plain'
        })
      )
      objectCreated = true
    } catch (err: any) {
      this.skip()
    }
  })

  after(async function () {
    if (!objectCreated || !s3Client) return
    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: S3_TEST_BUCKET,
          Key: TEST_OBJECT_KEY
        })
      )
    } catch {
      // ignore cleanup errors
    }
  })

  it('returns S3Storage from getStorageClass for type s3', function () {
    if (!canRunS3Tests()) this.skip()
    const file = {
      type: 's3',
      s3Access: {
        endpoint: S3_TEST_ENDPOINT,
        bucket: S3_TEST_BUCKET!,
        objectKey: TEST_OBJECT_KEY,
        accessKeyId: S3_TEST_ACCESS_KEY_ID!,
        secretAccessKey: S3_TEST_SECRET_ACCESS_KEY!,
        forcePathStyle: true
      }
    }
    const storage = Storage.getStorageClass(file, config)
    expect(storage).to.be.instanceOf(S3Storage)
  })

  it('validates S3 file object', function () {
    if (!canRunS3Tests()) this.skip()
    const file = {
      type: 's3',
      s3Access: {
        endpoint: S3_TEST_ENDPOINT,
        bucket: S3_TEST_BUCKET!,
        objectKey: TEST_OBJECT_KEY,
        accessKeyId: S3_TEST_ACCESS_KEY_ID!,
        secretAccessKey: S3_TEST_SECRET_ACCESS_KEY!,
        forcePathStyle: true
      }
    }
    const storage = Storage.getStorageClass(file, config) as S3Storage
    expect(storage.validate()).to.eql([true, ''])
  })

  it('gets readable stream and reads body', async function () {
    if (!canRunS3Tests()) this.skip()
    const file = {
      type: 's3',
      s3Access: {
        endpoint: S3_TEST_ENDPOINT,
        bucket: S3_TEST_BUCKET!,
        objectKey: TEST_OBJECT_KEY,
        accessKeyId: S3_TEST_ACCESS_KEY_ID!,
        secretAccessKey: S3_TEST_SECRET_ACCESS_KEY!,
        forcePathStyle: true
      }
    }
    const storage = Storage.getStorageClass(file, config) as S3Storage
    const result = await storage.getReadableStream()
    expect(result.httpStatus).to.equal(200)
    expect(result.stream).to.be.instanceOf(Readable)
    const chunks: Buffer[] = []
    for await (const chunk of result.stream as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks).toString('utf8')
    expect(body).to.equal(TEST_BODY)
  })

  it('fetches file metadata via fetchSpecificFileMetadata', async function () {
    if (!canRunS3Tests()) this.skip()
    const file = {
      type: 's3',
      s3Access: {
        endpoint: S3_TEST_ENDPOINT,
        bucket: S3_TEST_BUCKET!,
        objectKey: TEST_OBJECT_KEY,
        accessKeyId: S3_TEST_ACCESS_KEY_ID!,
        secretAccessKey: S3_TEST_SECRET_ACCESS_KEY!,
        forcePathStyle: true
      }
    }
    const storage = Storage.getStorageClass(file, config) as S3Storage
    const meta = await storage.fetchSpecificFileMetadata(file, false)
    expect(meta.valid).to.equal(true)
    expect(meta.type).to.equal('s3')
    expect(meta.contentLength).to.equal(String(TEST_BODY.length))
    expect(meta.contentType).to.equal('text/plain')
    expect(meta.name).to.equal('hello.txt')
  })

  it('getFileInfo returns file info for S3', async function () {
    if (!canRunS3Tests()) this.skip()
    const file = {
      type: 's3',
      s3Access: {
        endpoint: S3_TEST_ENDPOINT,
        bucket: S3_TEST_BUCKET!,
        objectKey: TEST_OBJECT_KEY,
        accessKeyId: S3_TEST_ACCESS_KEY_ID!,
        secretAccessKey: S3_TEST_SECRET_ACCESS_KEY!,
        forcePathStyle: true
      }
    }
    const storage = Storage.getStorageClass(file, config) as S3Storage
    const fileInfoRequest: FileInfoRequest = { type: FileObjectType.S3 }
    const fileInfo = await storage.getFileInfo(fileInfoRequest)
    expect(fileInfo).to.have.lengthOf(1)
    expect(fileInfo[0].valid).to.equal(true)
    expect(fileInfo[0].contentLength).to.equal(String(TEST_BODY.length))
    expect(fileInfo[0].contentType).to.equal('text/plain')
  })
})
