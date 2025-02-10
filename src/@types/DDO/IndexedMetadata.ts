import { Event } from './Event'

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
  stats?: Stats[]
  /**
   * Describes the event of last metadata event
   * @type {Event}
   */
  event?: Event
}
