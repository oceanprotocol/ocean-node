export interface EscrowAuthorization {
  address: string
  maxLockedAmount: BigInt
  currentLockedAmount: BigInt
  maxLockSeconds: BigInt
  maxLockCounts: BigInt
  currentLocks: BigInt
  // Escrow v2: 0 = indefinite, >0 = unix ts after which the payee can no longer create/extend
  // locks (claim/cancel are never gated). Present on v2 escrows only.
  expiryTimestamp?: BigInt
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
  oldAmount?: string
  newAmount?: string
  newExpiry?: string
  // Subsidized event fields
  provider?: string
  subsidyAmount?: string
  bonusAmount?: string
  // Auth event (Escrow v2): authorization expiry (0 = indefinite)
  expiryTimestamp?: string
  // SponsorRefunded event (Escrow v2): true => push failed, parked for sweep
  reclaimable?: boolean
}
