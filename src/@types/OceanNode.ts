import { OceanP2P } from '../components/P2P/index'
import { OceanProvider } from '../components/Provider/index'
import { OceanIndexer } from '../components/Indexer/index'
import type { PeerId } from '@libp2p/interface/peer-id'
import { Stream } from 'stream'
import { RPCS } from './blockchain'
import { Database } from '../components/database'

export interface OceanNodeDBConfig {
  url: string
}

export interface OceanNodeKeys {
  peerId: PeerId
  publicKey: any
  privateKey: any
  ethAddress: string
}

export interface OceanNodeP2PConfig {
  ipV4BindAddress: string | null
  ipV4BindTcpPort: number | null
  ipV4BindWsPort: number | null
  ipV6BindAddress: string | null
  ipV6BindTcpPort: number | null
  ipV6BindWsPort: number | null
  pubsubPeerDiscoveryInterval: number
  dhtMaxInboundStreams: number
  dhtMaxOutboundStreams: number
  mDNSInterval: number
  connectionsMaxParallelDials: number
  connectionsDialTimeout: number
}

export interface OceanNodeConfig {
  keys: OceanNodeKeys
  hasP2P: boolean
  p2pConfig: OceanNodeP2PConfig | null
  hasIndexer: boolean
  hasProvider: boolean
  hasHttp: boolean
  dbConfig: OceanNodeDBConfig
  httpPort: number
  supportedNetworks: RPCS
}

export interface P2PCommandResponse {
  status: any
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

export interface OceanNodeStatus {
  id: string
  publicKey: string
  address: string
  version: string
  http: boolean
  p2p: boolean
  provider: OceanNodeProvider[]
  indexer: OceanNodeIndexer[]
}

export interface P2PBroadcastResponse {
  command: string // original broadcast command
  message: any // original broadcast message
  response: any // the actual response to the original command and message
}

export interface FindDDOResponse {
  provider: string
  id: string
  lastUpdateTx: string
  lastUpdateTime: string
}
