import { BigNumberish } from 'ethers'

export interface OrderStartedEvent {
  consumer: string
  payer: string
  amount: BigNumberish
  serviceIndex: number
  timestamp: number
  publishMarketAddress: string
  blockNumber: number
}

export interface OrderReusedEvent {
  orderTxId: string
  caller: string
  timestamp: number
  number: number
}
