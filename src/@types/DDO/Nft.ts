export interface Nft {
  state: number
  address: string
  name?: string
  symbol?: string
  tokenURI?: string
  owner?: string
  created?: string
}

export interface NftRoles {
  manager: boolean
  deployERC20: boolean
  updateMetadata: boolean
  store: boolean
}
