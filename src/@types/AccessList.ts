/**
 * Mapping of `chainId` -> list of smart contract addresses on that chain.
 */
export interface AccessList {
  [chainId: string]: string[]
}

export interface AccessListUser {
  wallet: string
  tokenId: number
  block: number
  txId: string
  timestamp: number
}
