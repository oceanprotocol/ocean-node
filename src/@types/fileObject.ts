/* eslint-disable no-unused-vars */
import { Readable } from 'stream'

export interface HeadersObject {
  [key: string]: string
}

export enum EncryptMethod {
  AES = 'AES',
  ECIES = 'ECIES'
}

export interface BaseFileObject {
  type: string
  encryptedBy?: string
  encryptMethod?: EncryptMethod
}

export interface UrlFileObject extends BaseFileObject {
  url: string
  method: string
  headers?: HeadersObject
}

export interface IpfsFileObject extends BaseFileObject {
  hash: string
}

export interface ArweaveFileObject extends BaseFileObject {
  transactionId: string
}

export interface S3Object {
  endpoint: string
  region?: string
  objectKey: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** If true, use path-style addressing (e.g. endpoint/bucket/key). Required for some S3-compatible services (e.g. MinIO). Default false (virtual-host style, e.g. bucket.endpoint/key). */
  forcePathStyle?: boolean
}
export interface S3FileObject extends BaseFileObject {
  s3Access: S3Object
}

export type StorageObject =
  | UrlFileObject
  | IpfsFileObject
  | ArweaveFileObject
  | S3FileObject

export interface StorageReadable {
  stream: Readable
  httpStatus?: number
  headers?: Record<string, string | string[]> | undefined
  error?: any
}

export enum FileObjectType {
  URL = 'url',
  IPFS = 'ipfs',
  ARWEAVE = 'arweave',
  S3 = 's3'
}

export interface FileInfoRequest {
  type: FileObjectType
  fileIndex?: number
}

export interface FileInfoResponse {
  valid: boolean
  contentLength: string
  contentType: string
  checksum?: string
  name: string
  type: string
  encryptedBy?: string
  encryptMethod?: EncryptMethod
}

export interface FileInfoHttpRequest {
  type?: FileObjectType
  did?: string
  hash?: string
  url?: string
  transactionId?: string
  serviceId?: string
}
