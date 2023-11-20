export interface SupportedNetwork {
  chainId: number
  network: string
  rpc: string
  chunkSize: number
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
