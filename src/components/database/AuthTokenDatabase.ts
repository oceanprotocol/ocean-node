import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { AbstractDatabase } from './BaseDatabase.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { create256Hash } from '../../utils/crypt.js'
import { ElasticsearchAuthToken } from './ElasticsearchAuthToken.js'

export interface AuthToken {
  address: string
  createdAt: number
  validUntil: number | null
  isValid: boolean
  chainId?: string | null
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
  private provider: AuthTokenDatabaseProvider

  private constructor(config: OceanNodeDBConfig, provider?: AuthTokenDatabaseProvider) {
    super(config)
    this.provider = provider
  }

  static async create(config: OceanNodeDBConfig): Promise<AuthTokenDatabase> {
    DATABASE_LOGGER.debug('Creating AuthTokenDatabase with Elasticsearch')
    const provider = await ElasticsearchAuthToken.create(config)
    return new AuthTokenDatabase(config, provider)
  }

  async createToken(
    token: string,
    address: string,
    validUntil: number | null = null,
    createdAt: number,
    chainId?: string | null
  ): Promise<string> {
    await this.provider.createToken(
      create256Hash(token),
      address,
      createdAt,
      validUntil,
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
