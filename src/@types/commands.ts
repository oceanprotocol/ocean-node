import { ValidateParams } from '../components/httpRoutes/validateCommands.js'
import { DDO } from './DDO/DDO'
import { P2PCommandResponse } from './OceanNode'
import type { ComputeAsset, ComputeAlgorithm, ComputeOutput } from './C2D'
import {
  ArweaveFileObject,
  FileObjectType,
  EncryptMethod,
  IpfsFileObject,
  UrlFileObject,
  BaseFileObject
} from './fileObject'

export interface Command {
  command: string // command name
  node?: string // if not present it means current node
}

export interface AdminCommand extends Command {
  expiryTimestamp: number
  signature: string
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
  aes_encrypted_key?: string // if not present it means download without encryption
}

export interface FileInfoCommand extends Command {
  type?: FileObjectType
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
// this one gets the raw ddo
// https://github.com/oceanprotocol/ocean-node/issues/47
export interface ValidateDDOCommand extends Command {
  ddo: DDO
}

export interface StatusCommand extends Command {}
export interface DetailedStatusCommand extends StatusCommand {}
export interface EchoCommand extends Command {}

export interface QueryCommand extends Command {
  query: Record<string, any>
  maxResultsPerPage?: number
  pageNumber?: number
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
  encoding?: string
  encryptionType?: EncryptMethod.AES | EncryptMethod.ECIES
}

export interface EncryptFileCommand extends Command {
  encryptionType?: EncryptMethod.AES | EncryptMethod.ECIES
  files?: BaseFileObject
  rawData?: Buffer
  // UrlFileObject | ArweaveFileObject | IpfsFileObject
}

export interface NonceCommand extends Command {
  address: string // consumer address
}

export interface GetFeesCommand extends Command {
  ddoId: string
  serviceId: string
  consumerAddress?: string
  validUntil?: number // this allows a user to request a fee that is valid only for a limited period of time, less than service.timeout
}
// admin commands
export interface AdminStopNodeCommand extends AdminCommand {}
export interface AdminReindexTxCommand extends AdminCommand {
  chainId: number
  txId: string
}

export interface AdminReindexChainCommand extends AdminCommand {
  chainId: number
}

export interface ICommandHandler {
  handle(command: Command): Promise<P2PCommandResponse>
  validate(command: Command): ValidateParams
}

export interface BroadcastCommand {
  command: string // the name of the command
  message: any // the message to broadcast
}

export interface ComputeGetEnvironmentsCommand extends Command {
  chainId: number
}

export interface ComputeDetails {
  env: string // with hash
  validUntil: number
}
export interface ComputeInitializeCommand extends Command {
  datasets: [ComputeAsset]
  algorithm: ComputeAlgorithm
  compute: ComputeDetails
  consumerAddress: string
}

export interface ComputeStartCommand extends Command {
  consumerAddress: string
  signature: string
  nonce: string
  environment: string
  algorithm: ComputeAlgorithm
  dataset: ComputeAsset
  additionalDatasets?: ComputeAsset[]
  output?: ComputeOutput
}

export interface ComputeStopCommand extends Command {
  consumerAddress: string
  signature: string
  nonce: string
  jobId: string
}

export interface ComputeGetResultCommand extends Command {
  consumerAddress: string
  signature: string
  nonce: string
  jobId: string
  index: number
}

export interface ComputeGetStatusCommand extends Command {
  consumerAddress?: string
  did?: string
  jobId?: string
}

export interface ValidateChainId {
  validation: boolean
  networkRpc: string
}
