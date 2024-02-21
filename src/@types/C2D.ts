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
  /** Remote url */
  url?: string
}

export interface C2DEnvironment {
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
}
