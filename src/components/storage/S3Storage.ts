import {
  FileInfoResponse,
  S3FileObject,
  StorageReadable
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'stream'
import { CORE_LOGGER } from '../../utils/logging/common.js'

import { Storage } from './Storage.js'
import { checkUrlHost, createSafeHttpAgents } from '../../utils/safeUrl.js'

function normalizeEndpoint(endpoint: string): string {
  return endpoint.startsWith('http') ? endpoint : `https://${endpoint}`
}

function createS3Client(
  s3Access: S3FileObject['s3Access'],
  config: OceanNodeConfig
): S3Client {
  const endpoint = normalizeEndpoint(s3Access.endpoint)
  // SSRF: the endpoint is caller-supplied. Resolve it through the validating lookup so a
  // name that points at a private address is refused at connect time (IP literals are
  // refused earlier, in validate()).
  const { httpAgent, httpsAgent } = createSafeHttpAgents(config?.allowedPrivateUrlRanges)
  return new S3Client({
    endpoint,
    requestHandler: new NodeHttpHandler({ httpAgent, httpsAgent }),
    // Region is optional; default to us-east-1 if not provided
    region: s3Access.region ?? 'us-east-1',
    // Path-style (e.g. endpoint/bucket/key) required for some S3-compatible services (e.g. MinIO); default false for AWS virtual-host style
    forcePathStyle: s3Access.forcePathStyle ?? false,
    credentials: {
      accessKeyId: s3Access.accessKeyId,
      secretAccessKey: s3Access.secretAccessKey
    }
  })
}

export class S3Storage extends Storage {
  public constructor(file: S3FileObject, config: OceanNodeConfig) {
    super(file, config, true)
    const [isValid, message] = this.validate()
    if (isValid === false) {
      throw new Error(`Error validating the S3 file: ${message}`)
    }
  }

  validate(): [boolean, string] {
    const file: S3FileObject = this.getFile() as S3FileObject
    if (!file.s3Access) {
      return [false, 'Missing s3Access']
    }
    const { bucket, objectKey, endpoint, accessKeyId, secretAccessKey } = file.s3Access
    if (!bucket?.trim()) {
      return [false, 'Missing bucket']
    }
    if (!objectKey?.trim()) {
      return [false, 'Missing objectKey']
    }
    if (!endpoint?.trim()) {
      return [false, 'Missing endpoint']
    }
    if (!accessKeyId?.trim()) {
      return [false, 'Missing accessKeyId']
    }
    if (!secretAccessKey?.trim()) {
      return [false, 'Missing secretAccessKey']
    }
    const hostError = checkUrlHost(normalizeEndpoint(endpoint.trim()), this.config)
    if (hostError) {
      return [false, hostError]
    }
    return [true, '']
  }

  override async getReadableStream(): Promise<StorageReadable> {
    const { s3Access } = this.getFile() as S3FileObject
    const s3Client = createS3Client(s3Access, this.config)

    try {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: s3Access.bucket,
          Key: s3Access.objectKey
        })
      )

      if (!response.Body) {
        throw new Error('S3 GetObject returned no body')
      }

      return {
        httpStatus: response.$metadata.httpStatusCode ?? 200,
        stream: response.Body as Readable,
        headers: response.ContentType
          ? { 'Content-Type': response.ContentType }
          : undefined
      }
    } catch (err) {
      CORE_LOGGER.error(`Error fetching object from S3: ${err}`)
      throw err
    }
  }

  /**
   * Upload a file via S3 multipart upload (streaming). If s3Access.objectKey ends with /, the key becomes objectKey + filename; otherwise objectKey is the target key.
   * Uses @aws-sdk/lib-storage Upload so large streams are sent in parts without buffering the entire file.
   */
  async upload(
    filename: string,
    stream: Readable
  ): Promise<{ httpStatus: number; headers?: Record<string, string | string[]> }> {
    const { s3Access } = this.getFile() as S3FileObject
    const s3Client = createS3Client(s3Access, this.config)
    let key = s3Access.objectKey
    if (key.endsWith('/')) {
      key = `${key.replace(/\/+$/, '')}/${filename}`
    }
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: s3Access.bucket,
        Key: key,
        Body: stream,
        ContentType: 'application/octet-stream',
        ContentDisposition: `attachment; filename="${filename.replace(/"/g, '\\"')}"`
      },
      queueSize: 4,
      partSize: 5 * 1024 * 1024, // 5MB minimum for S3
      leavePartsOnError: false
    })
    await upload.done()
    return { httpStatus: 200, headers: {} }
  }

  async fetchSpecificFileMetadata(
    fileObject: S3FileObject,
    _forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const { s3Access } = fileObject
    const s3Client = createS3Client(s3Access, this.config)

    const data = await s3Client.send(
      new HeadObjectCommand({
        Bucket: s3Access.bucket,
        Key: s3Access.objectKey
      })
    )

    const contentLength = data.ContentLength != null ? String(data.ContentLength) : '0'
    const contentType = data.ContentType ?? 'application/octet-stream'
    const name = s3Access.objectKey.split('/').pop() ?? s3Access.objectKey

    return {
      valid: true,
      contentLength,
      contentType,
      checksum: data.ETag?.replace(/"/g, ''),
      name,
      type: 's3',
      encryptedBy: fileObject.encryptedBy,
      encryptMethod: fileObject.encryptMethod
    }
  }
}
