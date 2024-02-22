import { Readable } from 'stream'

export interface HeadersObject {
  [key: string]: string
}

export interface FileObject {
  type: string
}

export interface UrlFileObject extends FileObject {
  url: string
  method: string
  headers?: [HeadersObject]
}

export interface IpfsFileObject extends FileObject {
  hash: string
}

export interface ArweaveFileObject extends FileObject {
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
  name: string
  type: string
}

export interface FileInfoHttpRequest {
  type?: 'ipfs' | 'url' | 'arweave'
  did?: string
  hash?: string
  url?: string
  transactionId?: string
  serviceId?: string
}
