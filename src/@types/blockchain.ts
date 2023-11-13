export interface RPCS {
  [chainId: string]: string
}

export interface BlockchainData {
  chainId: number
  rpc: string
}

export interface NetworkEvent {
  type: string
  text: string
}

export interface Hashes {
  [hash: string]: NetworkEvent
}
