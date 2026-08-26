import { Stream } from 'stream'
import { RPCS } from './blockchain'
import { C2DClusterInfo, C2DDockerConfig } from './C2D/C2D'
import { FeeStrategy } from './Fees'
import { Schema } from '../components/database'
import { KeyProviderType } from './KeyManager'
import type { PersistentStorageConfig } from './PersistentStorage.js'
import type { AccessList } from './AccessList'

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
  type?: KeyProviderType
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
  dhtMaxInboundStreams: number
  dhtMaxOutboundStreams: number
  dhtFilter: dhtFilterMethod
  // When true, pass `clientMode: false` to kad-dht so this node is always a DHT server.
  // Left false, `clientMode` is omitted entirely so kad-dht registers its own auto-switch
  // listener and promotes/demotes based on whether this node currently has a public address.
  dhtForceServer: boolean
  mDNSInterval: number
  connectionsMaxParallelDials: number
  connectionsDialTimeout: number
  // libp2p's own default (`MAX_DIAL_QUEUE_LENGTH`) is 500; ocean-node did not expose it before.
  maxDialQueueLength: number
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
  // timeout / attempt budgets. These mirror the keys `OceanNodeP2PConfigSchema` already
  // declares (and `ENV_TO_CONFIG_MAPPING` already maps), so a config built by the schema always
  // carries them - they are `optional` here only so a hand-built config object (tests, fixtures)
  // stays assignable.
  //
  // Known seam: `src/components/P2P/timeouts.ts` still reads the `P2P_*` environment variables
  // directly rather than these fields, so a value set only in `config.json` reaches the
  // validated config and not the consuming code. Declaring the fields here is the type half of
  // closing that seam; the getter half belongs to `timeouts.ts`. The schema no longer blocks
  // that move - `OceanNodeP2PConfigSchema` now runs every one of these keys through the same
  // coercion rule the getters use, so a blank or malformed value falls back to the documented
  // default instead of becoming an instantly-expired `0`. What is still missing is a way for a
  // synchronous getter to reach an asynchronously-built config.
  findPeerTimeout?: number
  findProvidersTimeout?: number
  streamIdleTimeout?: number
  streamBodyTimeout?: number
  sendToResolveTimeout?: number
  sendToDialTimeout?: number
  sendToStreamTimeout?: number
  sendToTotalTimeout?: number
  sendToMaxAttempts?: number
  advertiseTimeout?: number
  peerStoreGetTimeout?: number
  discoveryDialTimeout?: number
  commandMaxInboundStreams?: number
  findDdoTimeout?: number
  providerRetrySleep?: number
  peerStoreMaxAddressAge?: number
  peerStoreMaxPeerAge?: number
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

export interface dockerRegistryAuth {
  username?: string
  password?: string
  auth?: string
}
export interface dockerRegistrysAuth {
  [registry: string]: dockerRegistryAuth
}

export interface OceanNodeConfig {
  dockerComputeEnvironments: C2DDockerConfig[]
  serviceTemplatesPath?: string // folder of *.json service templates; defaults to 'databases/serviceTemplates/'
  dockerRegistrysAuth: dockerRegistrysAuth
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
  dbConfig?: OceanNodeDBConfig
  // startup database-init retry: attempts, initial backoff (ms) and backoff ceiling (ms)
  dbInitMaxAttempts: number
  dbInitRetryDelay: number
  dbInitMaxRetryDelay: number
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
  enableBenchmark?: boolean
  persistentStorage?: PersistentStorageConfig
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

export interface AddressPerChain {
  [chainId: string]: string
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
  escrowAddress: AddressPerChain
  supportedStorage: StorageTypes
  platform: any
  uptime?: number // seconds since start
  codeHash?: string
  allowedAdmins?: { addresses: string[]; accessLists: AccessListContract }
  // detailed information
  c2dClusters?: any[]
  supportedSchemas?: Schema[]
  persistentStorage?: {
    accessLists?: AccessList[]
  }
}

export interface FindDDOResponse {
  provider: string
  id: string
  lastUpdateTx: string
  lastUpdateTime: string
}
