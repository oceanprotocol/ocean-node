import BigNumber from 'bignumber.js'

export type FeeTokens = {
  chain: string // chain id => 137
  token: string // token => token address 0x967da4048cD07aB37855c090aAF366e4ce1b9F48
}

export type FeeAmount = {
  amount: number
  unit: string // ex: MB, KB, GB, etc...
}
// ocean node fees
export type FeeStrategy = {
  feeTokens: FeeTokens[]
  feeAmount: FeeAmount
}

export interface ProviderFeeData {
  providerFeeAddress: string
  providerFeeToken: string
  providerFeeAmount: number | BigInt | BigNumber | string
  providerData: any
  v: any
  r: any
  s: any
  validUntil: number
}
