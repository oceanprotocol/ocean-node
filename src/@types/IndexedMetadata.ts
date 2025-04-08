export type PriceType = 'fixedrate' | 'dispenser'

export interface ServicePrice {
  type: PriceType
  price: string
  contract: string
  token?: string
  exchangeId?: string
}

export interface ServiceStats {
  datatokenAddress: string
  name: string
  symbol: string
  serviceId: string
  orders?: number
  prices?: ServicePrice[]
}
