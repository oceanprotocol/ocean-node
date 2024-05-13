export interface SupportedNetwork {
  chainId: number
  rpc: string
  network?: string
  chunkSize?: number
  startBlock?: number
  fallbackRPCs?: string[]
}

export interface RPCS {
  [chainId: string]: SupportedNetwork
}

export interface NetworkEvent {
  type: string
  text: string
}

export interface Hashes {
  [hash: string]: NetworkEvent
}

export interface BlocksEvents {
  [event: string]: any
}
export interface ProcessingEvents {
  lastBlock: number
  foundEvents: BlocksEvents
}

export interface ConnectionStatus {
  ready: boolean
  error?: string
}
