import type { MetadataAlgorithm } from './DDO/Metadata.js'

export enum C2DClusterType {
  // eslint-disable-next-line no-unused-vars
  OPF_K8 = 0,
  // eslint-disable-next-line no-unused-vars
  NODE_LOCAL = 1
}

export interface C2DClusterInfo {
  /** Type of cluster: K8, Node local, etc */
  type: C2DClusterType
  /** Hash of cluster.  hash(url) for remote, hash(nodeId) for local */
  hash: string
  /** Connection URI */
  connection?: string
}

export interface ComputeEnvironment {
  id: string
  cpuNumber: number
  cpuType: string
  gpuNumber: number
  gpuType: string
  ramGB: number
  diskGB: number
  priceMin: number
  desc: string
  currentJobs: number
  maxJobs: number
  consumerAddress: string
  storageExpiry: number
  maxJobDuration: number
  lastSeen: number
  chainId?: number
  feeToken: string
}

export interface ComputeEnvByChain {
  [chainId: number]: ComputeEnvironment[]
}

export type ComputeResultType =
  | 'algorithmLog'
  | 'output'
  | 'configrationLog'
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
  url?: string
  documentId: string
  serviceId: string
  transferTxId?: string
  userdata?: { [key: string]: any }
}

export interface ComputeAlgorithm {
  documentId?: string
  serviceId?: string
  url?: string
  meta?: MetadataAlgorithm
  transferTxId?: string
  algocustomdata?: { [key: string]: any }
  userdata?: { [key: string]: any }
}

/* The following are specific to OPF_k8 compute engine */
export interface OPFK8ComputeStageInput {
  index: number
  id?: string
  remote?: any
  url?: string[]
}
export interface OPFK8ComputeStageAlgorithm {
  id?: string
  url?: string
  remote?: any
  rawcode?: string
  container?: {
    /**
     * The command to execute, or script to run inside the Docker image.
     * @type {string}
     */
    entrypoint: string

    /**
     * Name of the Docker image.
     * @type {string}
     */
    image: string

    /**
     * Tag of the Docker image.
     * @type {string}
     */
    tag: string
  }
}

export interface OPFK8ComputeOutput {
  // this is a copy of ComputeOutput, but they could diverge in the future
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
export interface OPFK8ComputeStage {
  index: number
  input: OPFK8ComputeStageInput[]
  algorithm: OPFK8ComputeStageAlgorithm
  compute?: {}
  output: OPFK8ComputeOutput
}

export interface OPFK8ComputeWorkflow {
  stages: OPFK8ComputeStage[]
}
export interface OPFK8ComputeStart {
  workflow: OPFK8ComputeWorkflow
  owner: string
  agreementId: string
  providerSignature: string
  providerAddress: string
  environment: string
  validUntil: number
  nonce: number
  chainId: number
}

export interface OPFK8ComputeStop {
  jobId: string
  owner: string
  agreementId?: string
  providerSignature: string //  message=owner+jobId
  providerAddress: string
  nonce: number
}

export interface OPFK8ComputeGetStatus {
  agreementId?: string
  jobId?: string
  owner?: string
  providerSignature: string //  message=owner+jobId(if any)
  providerAddress: string
  nonce: number
}

export interface OPFK8ComputeGetResult {
  jobId: string
  owner: string
  index: number
  providerSignature: string //  message=owner+jobId
  providerAddress: string
  nonce: number
}

export interface AlgoChecksums {
  files: string
  container: string
}
