import { DDO } from './DDO/DDO'
import { P2PCommandResponse } from './OceanNode'
import { ArweaveFileObject, IpfsFileObject, UrlFileObject } from './fileObject'

export interface Command {
  command: string // command name
  node?: string // if not present it means current node
}

export interface DownloadURLCommand extends Command {
  fileObject: any
  aes_encrypted_key?: string // if not present it means download without encryption
}

export interface DownloadCommand extends Command {
  fileIndex: number
  documentId: string
  serviceId: string
  transferTxId: string
  nonce: string
  consumerAddress: string
  signature: string
  feeTx?: string
  feeData?: any
  aes_encrypted_key?: string // if not present it means download without encryption
}

export interface FileInfoCommand extends Command {
  type?: 'url' | 'ipfs' | 'arweave'
  did?: string
  serviceId?: string
  fileIndex?: number
  file?: UrlFileObject | ArweaveFileObject | IpfsFileObject
  checksum?: boolean
}
// group these 2
export interface DDOCommand extends Command {
  id: string
}
export interface GetDdoCommand extends DDOCommand {}
export interface FindDDOCommand extends DDOCommand {}
export interface ValidateDDOCommand extends DDOCommand {
  chainId: number
  nftAddress: string
}

export interface StatusCommand extends Command {}

export interface QueryCommand extends Command {
  query: Record<string, any>
}

export interface ReindexCommand extends Command {
  txId: string
  chainId: number
  eventIndex?: number
}

export interface DecryptDDOCommand extends Command {
  decrypterAddress: string
  chainId: number
  transactionId?: string
  dataNftAddress?: string
  encryptedDocument?: string
  flags?: number
  documentHash?: string
  nonce: string
  signature: string
}

export interface EncryptCommand extends Command {
  blob: string
  encoding: string
  encryptionType: string
}

export interface NonceCommand extends Command {
  address: string // consumer address
}

export interface GetFeesCommand extends Command {
  ddo: DDO
  serviceId: string
}

export interface ICommandHandler {
  handle(command: Command): Promise<P2PCommandResponse>
}

export interface BroadcastCommand {
  command: string // the name of the command
  message: any // the message to broadcast
}
