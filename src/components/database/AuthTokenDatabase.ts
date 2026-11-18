import { AbstractDatabase } from './BaseDatabase.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { create256Hash } from '../../utils/crypt.js'

export interface AuthToken {
  address: string
  createdAt: number
  validUntil: number | null
  isValid: boolean
  chainId?: string | null
}

// Unix ms from a number or a date text: a client can send the two, and an older release
// stored what it got. NaN when the value is not a time.
export function toUnixMs(value: number | string): number {
  const ms = Number(value)
  return Math.trunc(Number.isFinite(ms) ? ms : new Date(value).getTime())
}

// providers get the sha256 of the token (tokenId), never the token itself
export interface AuthTokenDatabaseProvider {
  createToken(
    tokenId: string,
    address: string,
    createdAt: number,
    validUntil: number | null,
    chainId?: string | null
  ): Promise<void>
  validateTokenEntry(tokenId: string): Promise<AuthToken | null>
  invalidateTokenEntry(tokenId: string): Promise<void>
  deleteExpiredTokens(now: number): Promise<number>
}

export class AuthTokenDatabase extends AbstractDatabase {
  constructor(
    config: OceanNodeDBConfig,
    private provider: AuthTokenDatabaseProvider
  ) {
    super(config)
  }

  async createToken(
    token: string,
    address: string,
    validUntil: number | null = null,
    createdAt: number,
    chainId?: string | null
  ): Promise<string> {
    // the default turns an undefined validUntil into null
    const until = validUntil === null ? null : toUnixMs(validUntil)
    if (Number.isNaN(until)) {
      throw new Error('validUntil must be a time in Unix milliseconds or a date')
    }
    await this.provider.createToken(
      create256Hash(token),
      address,
      createdAt,
      until,
      chainId
    )
    return token
  }

  async validateToken(token: string): Promise<AuthToken | null> {
    return await this.provider.validateTokenEntry(create256Hash(token))
  }

  async invalidateToken(token: string): Promise<void> {
    await this.provider.invalidateTokenEntry(create256Hash(token))
  }

  // removes expired and invalidated tokens; returns how many were deleted
  async deleteExpiredTokens(now: number): Promise<number> {
    return await this.provider.deleteExpiredTokens(now)
  }
}
