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
  headers?: [HeadersObject]
}

export interface IpfsFileObject extends BaseFileObject {
  hash: string
}

export interface ArweaveFileObject extends BaseFileObject {
  transactionId: string
}

export interface StorageReadable {
  stream: Readable
  httpStatus?: number
  headers?: [any]
}

export enum FileObjectType {
  URL = 'url',
  IPFS = 'ipfs',
  ARWEAVE = 'arweave'
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
  type?: 'ipfs' | 'url' | 'arweave'
  did?: string
  hash?: string
  url?: string
  transactionId?: string
  serviceId?: string
}
