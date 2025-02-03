import { Nft } from './Nft'

export type PriceType = 'fixedrate' | 'dispenser'

export interface Price {
  type: PriceType
  price: string
  contract: string
  token?: string
  exchangeId?: string
}

export interface Stats {
  datatokenAddress: string
  name: string
  symbol: string
  serviceId: string
  orders?: number
  prices?: Price[]
}

export interface IndexedMetadata {
  stats: Stats[]
  nft: Nft
}
