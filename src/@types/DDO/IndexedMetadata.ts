import { Event } from './Event'

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
  /**
   * Describes the event of last metadata event
   * @type {Event}
   */
  event: Event
}
