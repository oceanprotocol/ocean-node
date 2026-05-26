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
  amount: BigInt
  expiry: BigInt
  token: string
}

export interface EscrowEvent {
  id: string
  eventType: string
  chainId: number
  contract: string
  block: number
  txHash: string
  payer?: string
  payee?: string
  token?: string
  jobId?: string
  amount?: string
  expiry?: string
  proof?: string
  maxLockedAmount?: string
  maxLockSeconds?: string
  maxLockCounts?: string
}
