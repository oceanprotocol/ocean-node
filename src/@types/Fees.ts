import { BigNumberish } from 'ethers'

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
  providerFeeAmount: number | BigNumberish
  providerData: any
  v: any
  r: any
  s: any
  validUntil: number // this is always an absolute timestamp, till order is valid. Not a relative one (until further notice)
}

export interface ProviderFeeValidation {
  isValid: boolean // true if valid provider fee for download
  message: any
  validUntil: number
}

export interface ProviderFees {
  providerFeeAddress: string
  providerFeeToken: string
  providerFeeAmount: string
  v: string
  r: string
  s: string
  providerData: string
  validUntil: string
}

export interface ProviderInitialize {
  datatoken: string
  nonce: string
  computeAddress: string
  providerFee: ProviderFees
}

export interface ProviderComputeInitialize {
  datatoken?: string
  validOrder?: string
  providerFee?: ProviderFees
}

export interface ProviderComputeInitializePayment {
  escrowAddress: string
  payee: string
  chainId: number
  minLockSeconds: number
  token: string
  amount: string
}
export interface ProviderComputeInitializeResults {
  algorithm?: ProviderComputeInitialize
  datasets?: ProviderComputeInitialize[]
  payment: ProviderComputeInitializePayment
}
