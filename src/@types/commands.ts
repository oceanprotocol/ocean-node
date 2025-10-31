import { ValidateParams } from '../components/httpRoutes/validateCommands.js'
import { P2PCommandResponse } from './OceanNode'
import { DDO } from '@oceanprotocol/ddo-js'
import type {
  ComputeAsset,
  ComputeAlgorithm,
  ComputeOutput,
  ComputeResourceRequest,
  DBComputeJobMetadata
} from './C2D/C2D.js'
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
  authorization?: string
}

export interface GetP2PPeerCommand extends Command {
  peerId: string
}
export interface FindPeerCommand extends Command {
  peerId: string
  timeout?: string
}

export interface GetP2PPeersCommand extends Command {}
export interface GetP2PNetworkStatsCommand extends Command {}

export interface AdminCommand extends Command {
  expiryTimestamp: number
  signature: string
}

export interface AdminCollectFeesHandlerResponse {
  tx: string
  message: string
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
  policyServer?: any // object to pass to policy server
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
export interface FindDDOCommand extends DDOCommand {
  force?: boolean
}
// this one gets the raw ddo
// https://github.com/oceanprotocol/ocean-node/issues/47
export interface ValidateDDOCommand extends Command {
  ddo: DDO
  publisherAddress?: string
  nonce?: string
  signature?: string
  message?: string
}

export interface StatusCommand extends Command {
  detailed?: boolean
}
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
  policyServer?: any // object to pass to policyServer
}
// admin commands
export interface AdminStopNodeCommand extends AdminCommand {}
export interface AdminReindexTxCommand extends AdminCommand {
  chainId: number
  txId: string
}

export interface AdminCollectFeesCommand extends AdminCommand {
  tokenAddress: string
  chainId: number
  tokenAmount?: number
  destinationAddress: string
}

export interface AdminReindexChainCommand extends AdminCommand {
  chainId: number
  block?: number
}

export interface AdminFetchConfigCommand extends AdminCommand {}

export interface AdminPushConfigCommand extends AdminCommand {
  config: Record<string, any>
}

export interface ICommandHandler {
  handle(command: Command): Promise<P2PCommandResponse>
  verifyParamsAndRateLimits(task: Command): Promise<P2PCommandResponse>
}

export interface IValidateCommandHandler extends ICommandHandler {
  validate(command: Command): ValidateParams
}

export interface IValidateAdminCommandHandler extends ICommandHandler {
  validate(command: AdminCommand): Promise<ValidateParams>
}

export interface ComputeGetEnvironmentsCommand extends Command {
  chainId?: number
}

export interface ComputePayment {
  chainId: number
  token: string
  resources?: ComputeResourceRequest[] // only used in initializeCompute
}
export interface ComputeInitializeCommand extends Command {
  datasets: ComputeAsset[]
  algorithm: ComputeAlgorithm
  environment: string
  payment: ComputePayment
  consumerAddress: string
  signature?: string
  maxJobDuration: number
  policyServer?: any // object to pass to policy server
  queueMaxWaitTime?: number // max time in seconds a job can wait in the queue before being started
}

export interface FreeComputeStartCommand extends Command {
  consumerAddress: string
  signature: string
  nonce: string
  environment: string
  algorithm: ComputeAlgorithm
  datasets?: ComputeAsset[]
  output?: ComputeOutput
  resources?: ComputeResourceRequest[]
  maxJobDuration?: number
  policyServer?: any // object to pass to policy server
  metadata?: DBComputeJobMetadata
  additionalViewers?: string[] // addresses of additional addresses that can get results
  queueMaxWaitTime?: number // max time in seconds a job can wait in the queue before being started
}
export interface PaidComputeStartCommand extends FreeComputeStartCommand {
  payment: ComputePayment
}

export interface ComputeStopCommand extends Command {
  consumerAddress: string
  signature: string
  nonce: string
  jobId: string
  agreementId?: string
}

export interface ComputeGetResultCommand extends Command {
  consumerAddress: string
  signature: string
  nonce: string
  jobId: string
  index: number
}
export interface ComputeGetStreamableLogsCommand extends Command {
  consumerAddress: string
  signature: string
  nonce: string
  jobId: string
}

export interface ComputeGetStatusCommand extends Command {
  consumerAddress?: string
  jobId?: string
  agreementId?: string
}

export interface ValidateChainId {
  validation: boolean
  networkRpc: string
}
/* eslint-disable no-unused-vars */
export enum CommandStatus {
  DELIVERED = 'DELIVERED', // command was delivered successfully
  PENDING = 'PENDING', // command is pending excution or still running
  FAILURE = 'FAILURE', // command execution failed
  SUCCESS = 'SUCCESS' // command execution succeeded
}
export interface JobStatus {
  command: string
  timestamp: string
  jobId: string
  status: CommandStatus
  hash: string
}
export enum IndexingCommand {
  STOP_THREAD = 'start',
  START_THREAD = 'stop'
}
export interface StartStopIndexingCommand extends AdminCommand {
  chainId?: number
  action: IndexingCommand
}

export interface PolicyServerPassthroughCommand extends Command {
  policyServerPassthrough?: any
}

export interface PolicyServerInitializeCommand extends Command {
  documentId?: string
  serviceId?: string
  consumerAddress?: string
  policyServer?: any
}

export interface CreateAuthTokenCommand extends Command {
  address: string
  signature: string
  validUntil?: number | null
}

export interface InvalidateAuthTokenCommand extends Command {
  address: string
  signature: string
  token: string
}

export interface GetJobsCommand extends Command {
  environments?: string[]
  fromTimestamp?: string
  consumerAddrs?: string[]
}
