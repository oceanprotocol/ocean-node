import { OceanP2P } from '../components/P2P/index'
import { OceanProvider } from '../components/Provider/index'
import { OceanIndexer } from '../components/Indexer/index'
import type { PeerId } from '@libp2p/interface/peer-id'
import { Stream } from 'stream'
import { Blockchain } from '../utils/blockchain'

export interface OceanNodeDBConfig {
  host: string
  user: string
  pwd: string
  dbname: string
}

export interface OceanNodeKeys {
  peerId: PeerId
  publicKey: any
  privateKey: any
}
export interface OceanNodeConfig {
  keys: OceanNodeKeys
  hasP2P: boolean
  hasIndexer: boolean
  hasProvider: boolean
  hasHttp: boolean
  dbConfig: OceanNodeDBConfig
  httpPort: number
}

export interface OceanNode {
  node: OceanP2P | null
  indexer: OceanIndexer | null
  provider: OceanProvider | null
  blockchain: Blockchain
}

export interface P2PCommandResponse {
  status: any
  stream: Stream | null
}
