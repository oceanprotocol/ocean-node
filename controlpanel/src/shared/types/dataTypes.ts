export type IndexerType = {
  block: string
  chainId: string
  network: string
  delayed?: boolean
}

export type ProviderType = {
  chainId: string
  network: string
}

export type SupportedStorageType = {
  arwave: boolean
  ipfs: boolean
  url: boolean
}

export type PlatformType = {
  arch: string
  cpus: number
  freemem: number
  loadavg: number[]
  machine: string
  node: string
  osType: string
  osVersion: string
  platform: string
  release: string
  totalmem: number
}

export type NodeDataType = {
  address: string
  id: string
  publicKey: string
  uptime: string
  version: string
  http: boolean
  p2p: boolean
  indexer: IndexerType[]
  platform: PlatformType
  provider: ProviderType[]
  supportedStorage: SupportedStorageType
}
