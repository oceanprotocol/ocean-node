import { Readable } from 'stream'

export interface HeadersObject {
  [key: string]: string
}

export interface UrlFileObject {
  type: string
  url: string
  method: string
  headers?: [HeadersObject]
}

export interface IpfsFileObject {
  type: string
  hash: string
}

export interface ArweaveFileObject {
  type: string
  transactionId: string
}

export interface StorageReadable {
  stream: Readable
  httpStatus?: number
  headers?: [any]
}

export interface FileInfoRequest {
  type: 'url' | 'ipfs' | 'arweave'
  fileIndex?: number
}

export interface FileInfoResponse {
  valid: boolean
  contentLength: string
  contentType: string
  name: string
  type: string
}
