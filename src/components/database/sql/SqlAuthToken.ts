import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import {
  type AuthToken,
  type AuthTokenDatabaseProvider,
  toUnixMs
} from '../AuthTokenDatabase.js'
import type { SqlClient } from './SqlClient.js'

type TokenRow = {
  address: string
  createdAt: number
  // a database of an older release can hold a date text
  validUntil: number | string | null
  isValid: number
  chainId: string | null
}

// one row per token: "token" = the sha256 of the token, never the token itself
export class SqlAuthToken implements AuthTokenDatabaseProvider {
  constructor(private db: SqlClient) {}

  init(): Promise<void> {
    return this.db.exec(`
      CREATE TABLE IF NOT EXISTS "authTokens" (
        "token" TEXT PRIMARY KEY,
        "address" TEXT NOT NULL,
        "createdAt" BIGINT,
        "validUntil" BIGINT,
        "isValid" BIGINT DEFAULT 1,
        "chainId" TEXT
      )`)
  }

  async createToken(
    tokenId: string,
    address: string,
    createdAt: number,
    validUntil: number | null = null,
    chainId?: string | null
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO "authTokens" ("token", "address", "createdAt", "validUntil", "isValid", "chainId")
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT ("token") DO UPDATE SET
         "address" = excluded."address", "createdAt" = excluded."createdAt",
         "validUntil" = excluded."validUntil", "isValid" = 1, "chainId" = excluded."chainId"`,
      // text: SQLite stores the number 8996 in a TEXT column as '8996.0'
      [tokenId, address, createdAt, validUntil, chainId == null ? null : String(chainId)]
    )
  }

  // null for an unknown, invalidated or expired token; an expired one is invalidated
  async validateTokenEntry(tokenId: string): Promise<AuthToken | null> {
    const row = await this.db.get<TokenRow>(
      'SELECT * FROM "authTokens" WHERE "token" = ?',
      [tokenId]
    )
    if (!row || !row.isValid) {
      return null
    }
    const validUntil = row.validUntil === null ? null : toUnixMs(row.validUntil)
    // an end that is not a time counts as expired
    if (validUntil !== null && !(validUntil >= Date.now())) {
      DATABASE_LOGGER.debug('Expired auth token invalidated')
      await this.invalidateTokenEntry(tokenId)
      return null
    }
    return {
      address: row.address,
      createdAt: Number(row.createdAt),
      validUntil,
      isValid: true,
      chainId: row.chainId ?? null
    }
  }

  async invalidateTokenEntry(tokenId: string): Promise<void> {
    await this.db.run('UPDATE "authTokens" SET "isValid" = 0 WHERE "token" = ?', [
      tokenId
    ])
  }

  async deleteExpiredTokens(now: number): Promise<number> {
    const { changes } = await this.db.run(
      'DELETE FROM "authTokens" WHERE "validUntil" < ? OR "isValid" = 0',
      [now]
    )
    return changes
  }
}
