import { BigNumberish } from 'ethers'

export interface EscrowAuthorization {
  address: string
  maxLockedAmount: BigNumberish
  currentLockedAmount: BigNumberish
  maxLockSeconds: BigNumberish
  maxLockCounts: BigNumberish
  currentLocks: BigNumberish
}

export interface EscrowLock {
  jobId: BigNumberish
  payer: string
  payee: string
  amount: BigNumberish
  expiry: BigNumberish
  token: string
}
