import type { MetadataAlgorithm } from '../DDO/Metadata.js'

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
}

export interface ComputeEnvironment {
  id: string
  cpuNumber: number
  cpuType?: string
  gpuNumber?: number
  gpuType?: string
  ramGB: number
  diskGB: number
  priceMin: number
  desc: string
  currentJobs: number
  maxJobs: number
  consumerAddress: string
  storageExpiry: number
  maxJobDuration: number
  lastSeen?: number
  chainId?: number
  feeToken: string
  free: boolean
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

export interface AlgoChecksums {
  files: string
  container: string
}
