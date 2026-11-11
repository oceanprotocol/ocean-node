import { Client } from '@elastic/elasticsearch'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { AuthToken, AuthTokenDatabaseProvider } from './AuthTokenDatabase.js'
import {
  createElasticsearchClientWithRetry,
  ensureIndex,
  getOrNull
} from './ElasticsearchConfigHelper.js'
import { stateSchemas } from './ElasticSchemas.js'

const INDEX = stateSchemas.authTokens.index

// one document per token: id = sha256 of the token, the token itself is never stored
export class ElasticsearchAuthToken implements AuthTokenDatabaseProvider {
  private constructor(private config: OceanNodeDBConfig) {}

  // resolved per call: the health monitor replaces the client after a reconnect
  private client(): Promise<Client> {
    return createElasticsearchClientWithRetry(this.config)
  }

  static async create(config: OceanNodeDBConfig): Promise<ElasticsearchAuthToken> {
    await ensureIndex(config, stateSchemas.authTokens)
    return new ElasticsearchAuthToken(config)
  }

  async createToken(
    tokenId: string,
    address: string,
    createdAt: number,
    validUntil: number | null = null,
    chainId?: string | null
  ): Promise<void> {
    const body: AuthToken = {
      address,
      createdAt,
      validUntil,
      isValid: true,
      chainId: chainId ?? null
    }
    const client = await this.client()
    await client.index({ index: INDEX, id: tokenId, body, refresh: 'wait_for' })
  }

  // null for an unknown, invalidated or expired token; an expired one is invalidated
  async validateTokenEntry(tokenId: string): Promise<AuthToken | null> {
    const row = await getOrNull<AuthToken>(await this.client(), INDEX, tokenId)
    if (!row || !row.source.isValid) {
      return null
    }
    const entry = row.source
    if (entry.validUntil !== null && entry.validUntil < Date.now()) {
      DATABASE_LOGGER.debug('Expired auth token invalidated')
      await this.invalidateTokenEntry(tokenId)
      return null
    }
    return entry
  }

  async invalidateTokenEntry(tokenId: string): Promise<void> {
    try {
      const client = await this.client()
      await client.update({
        index: INDEX,
        id: tokenId,
        doc: { isValid: false },
        refresh: 'wait_for'
      })
    } catch (error) {
      // an unknown token has nothing to invalidate, like the SQL UPDATE it replaces
      if (error?.meta?.statusCode === 404) return
      throw error
    }
  }

  async deleteExpiredTokens(now: number): Promise<number> {
    const client = await this.client()
    const result = await client.deleteByQuery({
      index: INDEX,
      query: {
        bool: {
          should: [{ range: { validUntil: { lt: now } } }, { term: { isValid: false } }],
          minimum_should_match: 1
        }
      },
      refresh: true,
      conflicts: 'proceed'
    })
    return result.deleted ?? 0
  }
}
