import { Nft } from './Nft'

export interface Price {
  type: string
  price: string
  contract: string
  token?: string
  exchangeId?: string
}

export interface Stats {
  datatokenAddress: string
  name: string
  serviceId: string
  orders?: number
  prices?: Price[]
}

export interface IndexedMetadata {
  stats: Stats[]
  nft: Nft
}
