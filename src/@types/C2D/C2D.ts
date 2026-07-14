import { MetadataAlgorithm, ConsumerParameter } from '@oceanprotocol/ddo-js'
import type { BaseFileObject, StorageObject, EncryptMethod } from '../fileObject.js'
import type { AccessList } from '../AccessList.js'
import type { ServiceOnDemandConfig } from './ServiceOnDemand.js'

// Per-environment capability flags. Both default to true at config-parse and
// at runtime construction; only an explicit false disables a capability.
export interface ComputeEnvFeatures {
  computeJobs: boolean // false → COMPUTE_START + FREE_COMPUTE_START rejected
  services: boolean // false → SERVICE_START rejected; env hidden from service matching
}
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
export type ComputeResourceKind = 'discrete' | 'fungible'

export interface ResourceConstraint {
  id: ComputeResourceType // the resource being constrained
  min?: number // min units of this resource per unit of parent resource
  max?: number // max units of this resource per unit of parent resource
}

export interface ComputeResourcesPricingInfo {
  id: ComputeResourceType
  price: number // price per unit per minute
}

export interface ArgumentValues {
  [key: string]: string | number | boolean | any[] // Supports multiple value types
}

export interface dockerDeviceRequest {
  Driver: string
  Count?: number
  DeviceIDs: string[]
  Capabilities?: any
  Options?: any
}

// docker hw can be defined with either deviceRequests (simpler, if you have a driver), or in advanced way
// advanced way means you have to defined different params like devices, cggroups, caps, etc
export interface dockerHwInit {
  deviceRequests?: dockerDeviceRequest
  advanced?: ArgumentValues
  runtime?: string
}

export interface ComputeResource {
  id: ComputeResourceType
  description?: string
  type?: string
  kind?: ComputeResourceKind // 'discrete' | 'fungible'. Auto-inferred if omitted.
  shareable?: boolean // Only meaningful for kind:'discrete'. Default false.
  // true  → multiple jobs may share the device simultaneously (NIC, TPM, HSM)
  // false → exclusive: only one job at a time (GPU, FPGA)
  total: number // total number of specific resource
  cpuList?: string // connection-level cpu resource only: host core IDs jobs may be pinned to,
  // as comma-separated core IDs and/or ranges, ascending and non-overlapping
  // ("3", "0-1,3", "0-15,32-47"). Mutually exclusive with total; the effective
  // total is the expanded list length.
  min: number // min number of resource needed for a job
  max: number // max number of resource for a job
  inUse?: number // for display purposes
  driverVersion?: string
  memoryTotal?: string
  /**
   * `nvidia` | `amd` | `intel`
   */
  platform?: string
  init?: dockerHwInit
  constraints?: ResourceConstraint[] // optional cross-resource constraints
}
export interface EnvironmentResourceRef {
  id: ComputeResourceType // must match a resource id in C2DDockerConfig.resources or auto-detected (cpu/ram/disk)
  total?: number // env aggregate ceiling; if omitted → defaults to pool total (no per-env restriction)
  min?: number // per-job minimum
  max?: number // per-job maximum (capped to total if both present)
  constraints?: ResourceConstraint[] // per-env override: replaces pool constraints entirely
  // Omit to inherit pool constraints. Set [] to remove all constraints for this env.
}

export interface ComputeResourceRequest {
  id: string
  amount: number
}

export interface ComputeResourceRequestWithPrice extends ComputeResourceRequest {
  price?: number // price per unit per minute
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

export interface ComputeAccessList {
  addresses: string[]
  accessLists: AccessList[] | null
}

export interface ComputeEnvironmentFreeOptions {
  // only if a compute env exposes free jobs
  storageExpiry?: number
  maxJobDuration?: number
  minJobDuration?: number
  maxJobs?: number // maximum number of simultaneous free jobs
  resources?: ComputeResource[]
  access: ComputeAccessList
  allowImageBuild?: boolean
}

// Config-time only — used in C2DEnvironmentConfig.free.
// resources are EnvironmentResourceRef[] (refs to pool) and resolved to ComputeResource[] at startup.
// Runtime free options live in ComputeEnvironmentFreeOptions (unchanged).
export interface C2DEnvironmentFreeConfig {
  storageExpiry?: number
  maxJobDuration?: number
  minJobDuration?: number
  maxJobs?: number
  resources?: EnvironmentResourceRef[]
  access?: ComputeAccessList
  allowImageBuild?: boolean
}
export interface ComputeEnvironmentBaseConfig {
  description?: string // v1
  storageExpiry?: number // amount of seconds for storage
  minJobDuration?: number // min billable seconds for a paid job
  maxJobDuration?: number // max duration in seconds for a paid job
  maxJobs?: number // maximum number of simultaneous paid jobs
  fees: ComputeEnvFeesStructure
  resources?: ComputeResource[]
  access: ComputeAccessList
  free?: ComputeEnvironmentFreeOptions
  platform: RunningPlatform
  enableNetwork?: boolean // whether network is enabled for algorithm containers
  features?: ComputeEnvFeatures // always populated at runtime construction; gates compute/service starts
}

export interface ComputeRuntimes {
  [key: string]: {
    path?: string
    runtimeArgs?: string[] // Optional runtime arguments
  }
}
export interface ComputeEnvironment extends ComputeEnvironmentBaseConfig {
  id: string // v1
  runningJobs: number
  runningfreeJobs?: number
  consumerAddress: string // v1
  queuedJobs: number
  queuedFreeJobs: number
  queMaxWaitTime: number
  queMaxWaitTimeFree: number
  runMaxWaitTime: number
  runMaxWaitTimeFree: number
}

export interface C2DEnvironmentConfig {
  id?: string
  description?: string
  storageExpiry?: number
  minJobDuration?: number
  maxJobDuration?: number
  maxJobs?: number
  fees?: ComputeEnvFeesStructure
  access?: ComputeAccessList
  free?: C2DEnvironmentFreeConfig // config-time only; resolved to ComputeEnvironmentFreeOptions at startup
  resources?: EnvironmentResourceRef[] // lightweight refs to connection pool
  enableNetwork?: boolean // whether network is enabled for algorithm containers
  features?: ComputeEnvFeatures // config-time, optional
}

export interface C2DDockerConfig {
  socketPath: string
  protocol: string
  host: string
  port: number
  caPath: string
  certPath: string
  keyPath: string
  imageRetentionDays?: number // Default: 7 days
  imageCleanupInterval?: number // Default: 86400 seconds (24 hours)
  paymentClaimInterval?: number // Default: 3600 seconds (1 hours)
  scanImages?: boolean
  scanImageDBUpdateInterval?: number // Default: 12 hours
  resources?: ComputeResource[] // optional: cpu/ram/disk auto-detected; include for GPUs/NICs or to cap auto-detected totals
  environments: C2DEnvironmentConfig[]
  serviceOnDemand?: ServiceOnDemandConfig // per-daemon Service-on-Demand operational config
}

export type ComputeResultType =
  | 'imageLog'
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

export type DBComputeJobMetadata = {
  [key: string]: string | number | boolean
}

export interface ComputeJobTerminationDetails {
  OOMKilled: boolean
  exitCode: number
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
  maxJobDuration?: number
  agreementId?: string
  environment?: string
  metadata?: DBComputeJobMetadata
  terminationDetails?: ComputeJobTerminationDetails
  queueMaxWaitTime: number // max time in seconds a job can wait in the queue before being started
}

export interface ComputeOutputEncryption {
  encryptMethod: EncryptMethod.AES // in future we will support more ciphers
  key: string // AES symetric key
}

export interface ComputeOutput {
  remoteStorage?: StorageObject
  encryption?: ComputeOutputEncryption
}

export interface ComputeAsset {
  fileObject?: BaseFileObject
  documentId?: string
  serviceId?: string
  transferTxId?: string
  userdata?: { [key: string]: any }
}
export interface ExtendedMetadataAlgorithm extends MetadataAlgorithm {
  container: {
    // retain existing properties
    entrypoint: string
    image: string
    tag: string
    checksum: string
    dockerfile?: string // optional
    additionalDockerFiles?: { [key: string]: any }
    consumerParameters?: ConsumerParameter[]
  }
}
export interface ComputeAlgorithm {
  documentId?: string
  serviceId?: string
  fileObject?: BaseFileObject
  meta?: ExtendedMetadataAlgorithm
  transferTxId?: string
  algocustomdata?: { [key: string]: any }
  userdata?: { [key: string]: any }
  envs?: { [key: string]: any }
}

export interface AlgoChecksums {
  files: string
  container: string
  serviceId?: string
}

export interface DBComputeJobPayment {
  chainId: number
  token: string
  lockTx: string
  claimTx: string
  cancelTx: string
  cost: number
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
  isFree: boolean
  algoStartTimestamp: string
  algoStopTimestamp: string
  resources: ComputeResourceRequestWithPrice[]
  payment?: DBComputeJobPayment
  metadata?: DBComputeJobMetadata
  additionalViewers?: string[] // addresses of additional addresses that can get results
  algoDuration: number // duration of the job in seconds
  encryptedDockerRegistryAuth?: string
  output?: string // this is always an ECIES encrypted string, that decodes to ComputeOutput interface
  outputBucketId?: string
  jobIdHash: string
  buildStartTimestamp?: string
  buildStopTimestamp?: string
}

// make sure we keep them both in sync
export enum C2DStatusNumber {
  // eslint-disable-next-line no-unused-vars
  JobStarted = 0,
  // eslint-disable-next-line no-unused-vars
  JobQueued = 1,
  // eslint-disable-next-line no-unused-vars
  JobQueuedExpired = 2,
  // eslint-disable-next-line no-unused-vars
  PullImage = 10,
  // eslint-disable-next-line no-unused-vars
  PullImageFailed = 11,
  // eslint-disable-next-line no-unused-vars
  BuildImage = 12,
  // eslint-disable-next-line no-unused-vars
  BuildImageFailed = 13,
  // eslint-disable-next-line no-unused-vars
  VulnerableImage = 14,
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
  DataUploadFailed = 33,
  // eslint-disable-next-line no-unused-vars
  RunningAlgorithm = 40,
  // eslint-disable-next-line no-unused-vars
  AlgorithmFailed = 41,
  // eslint-disable-next-line no-unused-vars
  DiskQuotaExceeded = 42,
  // eslint-disable-next-line no-unused-vars
  FilteringResults = 50,
  // eslint-disable-next-line no-unused-vars
  PublishingResults = 60,
  // eslint-disable-next-line no-unused-vars
  ResultsFetchFailed = 61,
  // eslint-disable-next-line no-unused-vars
  ResultsUploadFailed = 62,
  // eslint-disable-next-line no-unused-vars
  JobFinished = 70,
  // eslint-disable-next-line no-unused-vars
  JobSettle = 71
}
export enum C2DStatusText {
  // eslint-disable-next-line no-unused-vars
  JobStarted = 'Job started',
  // eslint-disable-next-line no-unused-vars
  JobQueued = 'Job queued',
  // eslint-disable-next-line no-unused-vars
  JobQueuedExpired = 'Job expired in queue',
  // eslint-disable-next-line no-unused-vars
  PullImage = 'Pulling algorithm image',
  // eslint-disable-next-line no-unused-vars
  PullImageFailed = 'Pulling algorithm image failed',
  // eslint-disable-next-line no-unused-vars
  BuildImage = 'Building algorithm image',
  // eslint-disable-next-line no-unused-vars
  BuildImageFailed = 'Building algorithm image failed',
  // eslint-disable-next-line no-unused-vars
  VulnerableImage = 'Image has vulnerabilities',
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
  DiskQuotaExceeded = 'Error: disk quota exceeded',
  // eslint-disable-next-line no-unused-vars
  FilteringResults = 'Filtering results',
  // eslint-disable-next-line no-unused-vars
  PublishingResults = 'Publishing results',
  // eslint-disable-next-line no-unused-vars
  ResultsFetchFailed = 'Failed to get outputs folder from container',
  // eslint-disable-next-line no-unused-vars
  ResultsUploadFailed = 'Failed to upload results to storage',
  // eslint-disable-next-line no-unused-vars
  JobFinished = 'Job finished',
  // eslint-disable-next-line no-unused-vars
  JobSettle = 'Job settling'
}
