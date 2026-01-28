import { Stream } from 'stream'
import { RPCS } from './blockchain'
import { C2DClusterInfo, C2DDockerConfig } from './C2D/C2D'
import { FeeStrategy } from './Fees'
import { Schema } from '../components/database'

export interface OceanNodeDBConfig {
  url: string | null
  username?: string
  password?: string
  dbType: string | null
}

// deny list of peer ids and ips (for rate limiting purposes)
export interface DenyList {
  peers: string[]
  ips: string[]
}

export interface OceanNodeKeys {
  peerId: any
  publicKey: any
  privateKey: any
  ethAddress: string
  type?: string | 'raw' | 'gcp-kms' // Key provider type (raw, gcp-kms, etc.)
  // Raw private key config (when type is 'raw')
  // GCP KMS config (when type is 'gcp-kms')
  gcpKmsConfig?: {
    projectId: string
    location: string
    keyRing: string
    keyName: string
    keyVersion?: string
  }
}
/* eslint-disable no-unused-vars */
export enum dhtFilterMethod {
  filterPrivate = 'filterPrivate', // default, remove all private addresses from DHT
  filterPublic = 'filterPublic', // remove all public addresses from DHT
  filterNone = 'filterNone' // do not remove all any addresses from DHT
}
export interface OceanNodeP2PConfig {
  bootstrapNodes: string[]
  bootstrapTimeout: number
  bootstrapTagName: string
  bootstrapTagValue: number
  bootstrapTTL: number
  enableIPV4: boolean
  enableIPV6: boolean
  ipV4BindAddress: string | null
  ipV4BindTcpPort: number | null
  ipV4BindWsPort: number | null
  ipV4BindWssPort: number | null
  ipV6BindAddress: string | null
  ipV6BindTcpPort: number | null
  ipV6BindWsPort: number | null
  pubsubPeerDiscoveryInterval: number
  dhtMaxInboundStreams: number
  dhtMaxOutboundStreams: number
  dhtFilter: dhtFilterMethod
  mDNSInterval: number
  connectionsMaxParallelDials: number
  connectionsDialTimeout: number
  announceAddresses: string[]
  filterAnnouncedAddresses: string[]
  autoNat: boolean
  upnp: boolean
  enableCircuitRelayServer: boolean
  enableCircuitRelayClient: boolean
  circuitRelays: number
  announcePrivateIp: boolean
  minConnections: number
  maxConnections: number
  autoDialPeerRetryThreshold: number
  autoDialConcurrency: number
  maxPeerAddrsToDial: number
  autoDialInterval: number
  enableNetworkStats: boolean
}

export interface OceanNodeDockerConfig {
  socketPath?: string
  protocol?: string
  host?: string
  port?: number
  caPath?: string
  certPath?: string
  keyPath?: string
}

export interface AccessListContract {
  [chainId: string]: string[]
}

export interface OceanNodeConfig {
  dockerComputeEnvironments: C2DDockerConfig[]
  authorizedDecrypters: string[]
  authorizedDecryptersList: AccessListContract | null
  allowedValidators: string[]
  allowedValidatorsList: AccessListContract | null
  authorizedPublishers: string[]
  authorizedPublishersList: AccessListContract | null
  keys: OceanNodeKeys
  hasP2P: boolean
  p2pConfig: OceanNodeP2PConfig | null
  hasIndexer: boolean
  hasHttp: boolean
  hasControlPanel: boolean
  dbConfig?: OceanNodeDBConfig
  httpPort: number
  feeStrategy: FeeStrategy
  ipfsGateway?: string | null
  arweaveGateway?: string | null
  supportedNetworks?: RPCS
  claimDurationTimeout: number
  indexingNetworks?: RPCS
  c2dClusters: C2DClusterInfo[]
  accountPurgatoryUrl: string | null
  assetPurgatoryUrl: string | null
  allowedAdmins?: string[]
  allowedAdminsList?: AccessListContract | null
  codeHash?: string
  rateLimit?: number // per request ip or peer
  maxConnections?: number // global, regardless of client address(es)
  denyList?: DenyList
  unsafeURLs?: string[]
  isBootstrap?: boolean
  validateUnsignedDDO?: boolean
  jwtSecret?: string
  httpCertPath?: string
  httpKeyPath?: string
}

export interface P2PStatusResponse {
  httpStatus: number
  error?: string
  headers?: any
}
export interface P2PCommandResponse {
  status: P2PStatusResponse
  stream: Stream | null
}

export interface OceanNodeProvider {
  chainId: string
  network: string
}

export interface OceanNodeIndexer {
  chainId: string
  network: string
  block?: string // mark it as optional until the functionality is done
}

export interface StorageTypes {
  ipfs: boolean
  arwave: boolean
  url: boolean
}

export interface OceanNodeStatus {
  id: string
  publicKey: string
  friendlyName: string
  address: string
  version: string
  http: boolean
  p2p: boolean
  provider: OceanNodeProvider[]
  indexer: OceanNodeIndexer[]
  supportedStorage: StorageTypes
  platform: any
  uptime?: number // seconds since start
  codeHash?: string
  allowedAdmins?: { addresses: string[]; accessLists: AccessListContract }
  // detailed information
  c2dClusters?: any[]
  supportedSchemas?: Schema[]
}

export interface FindDDOResponse {
  provider: string
  id: string
  lastUpdateTx: string
  lastUpdateTime: string
}
