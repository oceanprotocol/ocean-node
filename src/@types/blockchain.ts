export interface RPCS {
  [chainId: string]: string
}

export interface BlockchainData {
  chainId: number
  rpc: string
}
