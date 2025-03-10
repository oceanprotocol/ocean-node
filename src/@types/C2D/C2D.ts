import type { MetadataAlgorithm } from '../DDO/Metadata.js'
import type { BaseFileObject } from '../fileObject.js'
export enum C2DClusterType {
  // eslint-disable-next-line no-unused-vars
  OPF_K8 = 0,
  // eslint-disable-next-line no-unused-vars
  NODE_LOCAL = 1,
  // eslint-disable-next-line no-unused-vars
  DOCKER = 2
}

export interface C2DClusterInfo {
  /** Type of cluster: K8, Node local, etc */
  type: C2DClusterType
  /** Hash of cluster.  hash(url) for remote, hash(nodeId) for local */
  hash: string
  /** Connection URI */
  connection?: any
  /** Folder for storing data */
  tempFolder?: string
}

export type ComputeResourceType = 'cpu' | 'ram' | 'disk' | any

export interface ComputeResourcesPricingInfo {
  id: ComputeResourceType
  price: number // price per unit
}

export interface ComputeResource {
  id: ComputeResourceType
  type?: string
  kind?: string
  total: number // total number of specific resource
  min: number // min number of resource needed for a job
  max: number // max number of resource for a job
  inUse?: number // for display purposes
}
export interface ComputeResourceRequest {
  id: string
  amount: number
}

export interface ComputeEnvFees {
  feeToken: string
  prices: ComputeResourcesPricingInfo[]
}
export interface ComputeEnvFeesStructure {
  [chainId: string]: ComputeEnvFees[]
}

export interface RunningPlatform {
  architecture: string
  os?: string
}

export interface ComputeEnvironmentFreeOptions {
  // only if a compute env exposes free jobs
  storageExpiry?: number
  maxJobDuration?: number
  maxJobs?: number // maximum number of simultaneous free jobs
  resources?: ComputeResource[]
}
export interface ComputeEnvironmentBaseConfig {
  description?: string // v1
  storageExpiry?: number // amount of seconds for storage
  minJobDuration?: number // min billable seconds for a paid job
  maxJobDuration?: number // max duration in seconds for a paid job
  maxJobs?: number // maximum number of simultaneous paid jobs
  fees: ComputeEnvFeesStructure
  resources?: ComputeResource[]
  free?: ComputeEnvironmentFreeOptions
  platform: RunningPlatform
}

export interface ComputeEnvironment extends ComputeEnvironmentBaseConfig {
  id: string // v1
  runningJobs: number
  runningfreeJobs?: number
  consumerAddress: string // v1
}

export interface C2DDockerConfig {
  socketPath: string
  protocol: string
  host: string
  port: number
  caPath: string
  certPath: string
  keyPath: string
  storageExpiry?: number
  maxJobDuration?: number
  maxJobs?: number
  fees: ComputeEnvFeesStructure
  resources?: ComputeResource[] // optional, owner can overwrite
  free?: ComputeEnvironmentFreeOptions
}

export type ComputeResultType =
  | 'algorithmLog'
  | 'output'
  | 'configurationLog'
  | 'publishLog'

export interface ComputeResult {
  filename: string
  filesize: number
  type: ComputeResultType
  index?: number
}

export interface ComputeJob {
  owner: string
  did?: string
  jobId: string
  dateCreated: string
  dateFinished: string
  status: number
  statusText: string
  results: ComputeResult[]
  inputDID?: string[]
  algoDID?: string
  agreementId?: string
  expireTimestamp: number
  environment?: string
}

export interface ComputeOutput {
  publishAlgorithmLog?: boolean
  publishOutput?: boolean
  providerAddress?: string
  providerUri?: string
  metadataUri?: string
  nodeUri?: string
  owner?: string
  secretStoreUri?: string
  whitelist?: string[]
}

export interface ComputeAsset {
  fileObject?: BaseFileObject
  documentId?: string
  serviceId?: string
  transferTxId?: string
  userdata?: { [key: string]: any }
}

export interface ComputeAlgorithm {
  documentId?: string
  serviceId?: string
  fileObject?: BaseFileObject
  meta?: MetadataAlgorithm
  transferTxId?: string
  algocustomdata?: { [key: string]: any }
  userdata?: { [key: string]: any }
}

export interface AlgoChecksums {
  files: string
  container: string
}

// this is the internal structure
export interface DBComputeJob extends ComputeJob {
  clusterHash: string
  configlogURL: string
  publishlogURL: string
  algologURL: string
  outputsURL: string
  stopRequested: boolean
  algorithm: ComputeAlgorithm
  assets: ComputeAsset[]
  isRunning: boolean
  isStarted: boolean
  containerImage: string
  resources: ComputeResourceRequest[]
  isFree: boolean
}

// make sure we keep them both in sync
export enum C2DStatusNumber {
  // eslint-disable-next-line no-unused-vars
  JobStarted = 0,
  // eslint-disable-next-line no-unused-vars
  PullImage = 10,
  // eslint-disable-next-line no-unused-vars
  PullImageFailed = 11,
  // eslint-disable-next-line no-unused-vars
  ConfiguringVolumes = 20,
  // eslint-disable-next-line no-unused-vars
  VolumeCreationFailed = 21,
  // eslint-disable-next-line no-unused-vars
  ContainerCreationFailed = 22,
  // eslint-disable-next-line no-unused-vars
  Provisioning = 30,
  // eslint-disable-next-line no-unused-vars
  DataProvisioningFailed = 31,
  // eslint-disable-next-line no-unused-vars
  AlgorithmProvisioningFailed = 32,
  // eslint-disable-next-line no-unused-vars
  DataUploadFailed = 32,
  // eslint-disable-next-line no-unused-vars
  RunningAlgorithm = 40,
  // eslint-disable-next-line no-unused-vars
  AlgorithmFailed = 41,
  // eslint-disable-next-line no-unused-vars
  FilteringResults = 50,
  // eslint-disable-next-line no-unused-vars
  PublishingResults = 60,
  // eslint-disable-next-line no-unused-vars
  ResultsFetchFailed = 61,
  // eslint-disable-next-line no-unused-vars
  ResultsUploadFailed = 62,
  // eslint-disable-next-line no-unused-vars
  JobFinished = 70
}
export enum C2DStatusText {
  // eslint-disable-next-line no-unused-vars
  JobStarted = 'Job started',
  // eslint-disable-next-line no-unused-vars
  PullImage = 'Pulling algorithm image',
  // eslint-disable-next-line no-unused-vars
  PullImageFailed = 'Pulling algorithm image failed',
  // eslint-disable-next-line no-unused-vars
  ConfiguringVolumes = 'Configuring volumes',
  // eslint-disable-next-line no-unused-vars
  VolumeCreationFailed = 'Volume creation failed',
  // eslint-disable-next-line no-unused-vars
  ContainerCreationFailed = 'Container creation failed',
  // eslint-disable-next-line no-unused-vars
  Provisioning = 'Provisioning data',
  // eslint-disable-next-line no-unused-vars
  DataProvisioningFailed = 'Data provisioning failed',
  // eslint-disable-next-line no-unused-vars
  AlgorithmProvisioningFailed = 'Algorithm provisioning failed',
  // eslint-disable-next-line no-unused-vars
  DataUploadFailed = 'Data upload to container failed',
  // eslint-disable-next-line no-unused-vars
  RunningAlgorithm = 'Running algorithm ',
  // eslint-disable-next-line no-unused-vars
  AlgorithmFailed = 'Failed to run algorithm',
  // eslint-disable-next-line no-unused-vars
  FilteringResults = 'Filtering results',
  // eslint-disable-next-line no-unused-vars
  PublishingResults = 'Publishing results',
  // eslint-disable-next-line no-unused-vars
  ResultsFetchFailed = 'Failed to get outputs folder from container',
  // eslint-disable-next-line no-unused-vars
  ResultsUploadFailed = 'Failed to upload results to storage',
  // eslint-disable-next-line no-unused-vars
  JobFinished = 'Job finished'
}
