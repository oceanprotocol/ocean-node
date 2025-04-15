export interface EscrowAuthorization {
  address: string
  maxLockedAmount: BigInt
  currentLockedAmount: BigInt
  maxLockSeconds: BigInt
  maxLockCounts: BigInt
  currentLocks: BigInt
}

export interface EscrowLock {
  jobId: BigInt
  payer: string
  payee: string
  amount: BigInt
  expiry: BigInt
  token: string
}
