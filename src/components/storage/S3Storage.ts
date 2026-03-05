import {
  FileInfoResponse,
  S3FileObject,
  StorageReadable
} from '../../@types/fileObject.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'stream'
import { CORE_LOGGER } from '../../utils/logging/common.js'

import { Storage } from './Storage.js'

function createS3Client(s3Access: S3FileObject['s3Access']): S3Client {
  const endpoint = s3Access.endpoint.startsWith('http')
    ? s3Access.endpoint
    : `https://${s3Access.endpoint}`
  return new S3Client({
    endpoint,
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
    super(file, config)
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
    return [true, '']
  }

  override async getReadableStream(): Promise<StorageReadable> {
    const { s3Access } = this.getFile() as S3FileObject
    const s3Client = createS3Client(s3Access)

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

  async fetchSpecificFileMetadata(
    fileObject: S3FileObject,
    _forceChecksum: boolean
  ): Promise<FileInfoResponse> {
    const { s3Access } = fileObject
    const s3Client = createS3Client(s3Access)

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
