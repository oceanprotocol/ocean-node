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

// export type ComputeResourceType = 'cpu' | 'memory' | 'storage'

export interface ComputeResourcesPricingInfo {
  id: string
  price: number
}

export interface ComputeResources {
  id: string
  type?: string
  kind?: string
}
export interface ComputeEnvFees {
  feeToken: string
  prices: ComputeResourcesPricingInfo[]
}
export interface ComputeEnvFeesStructure {
  [chainId: string]: ComputeEnvFees
}

export interface RunningPlatform {
  architecture: string
  os?: string
}

export interface ComputeEnvironmentFreeOptions {
  // only if a compute env exposes free jobs
  maxCpu?: number // max cpu for a single job.
  maxRam?: number // max allocatable RAM for a single job in bytes.
  maxDisk?: number // max disk space in bytes allocatable for a single job
  storageExpiry?: number
  maxJobDuration?: number
  maxJobs: number // maximum number of free jobs in the same time
}
export interface ComputeEnvironmentBaseConfig {
  // cpuNumber: number
  // ramGB: number
  // diskGB: number
  description?: string // v1
  // maxJobs: number
  storageExpiry: number // v1
  maxJobDuration: number // v1 max seconds for a job
  // chainId?: number
  // feeToken: string
  // priceMin: number
  totalCpu?: number // total cpu available for jobs
  totalRam?: number // total bytes of RAM
  maxCpu?: number // max cpu for a single job.  Imagine a K8 cluster with two nodes, each node with 10 cpus.  Total=20, but at most you can allocate 10 cpu for a job
  maxRam?: number // max allocatable RAM for a single job in bytes.
  maxDisk?: number // max disk space in bytes allocatable for a single job
  free?: ComputeEnvironmentFreeOptions
  fees: ComputeEnvFeesStructure
  resources?: ComputeResources[]
  platform?: RunningPlatform[]
}

export interface ComputeEnvironment extends ComputeEnvironmentBaseConfig {
  id: string // v1
  currentJobs: number
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
  environments: ComputeEnvironment[]
}

export interface ComputeEnvByChain {
  [chainId: number]: ComputeEnvironment[]
}

export interface ComputeResourceRequest {
  type: string
  amount: number
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
}

// make sure we keep them both in sync
export enum C2DStatusNumber {
  // eslint-disable-next-line no-unused-vars
  JobStarted = 0,
  // eslint-disable-next-line no-unused-vars
  PullImage = 10,
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
