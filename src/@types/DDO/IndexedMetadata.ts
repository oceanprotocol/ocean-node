import { Event } from './Event'

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

export interface IndexedMetadata {
  stats?: ServiceStats[]
  /**
   * Describes the event of last metadata event
   * @type {Event}
   */
  event?: Event
}
