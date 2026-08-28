import { AuthToken } from './AuthTokenDatabase.js'
import { SqliteClient } from './sqliteClient.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'

interface AuthTokenDatabaseProvider {
  createToken(
    token: string,
    address: string,
    createdAt: number,
    validUntil: number | null,
    chainId?: string | null
  ): Promise<void>
  validateTokenEntry(token: string): Promise<AuthToken | null>
  invalidateTokenEntry(token: string): Promise<void>
}

export class SQLiteAuthToken implements AuthTokenDatabaseProvider {
  private db: SqliteClient

  constructor(dbFilePath: string) {
    this.db = new SqliteClient(dbFilePath)
  }

  // eslint-disable-next-line require-await
  async createTable(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authTokens (
        token TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        validUntil DATETIME,
        isValid BOOLEAN DEFAULT TRUE,
        chainId TEXT
      )
    `)

    // Migration for DBs created before the chainId column existed: add it if missing.
    // A fresh table already has the column, so ALTER throws "duplicate column name" —
    // that's the only expected failure, so swallow it. With the synchronous exec above this
    // now runs strictly after the CREATE TABLE, unlike the old callback-based `await exec`
    // which never actually waited and let the CREATE race the ALTER.
    try {
      this.db.exec(`ALTER TABLE authTokens ADD COLUMN chainId TEXT`)
    } catch {
      // column already exists
    }
  }

  // eslint-disable-next-line require-await
  async createToken(
    token: string,
    address: string,
    createdAt: number,
    validUntil: number | null = null,
    chainId?: string | null
  ): Promise<void> {
    const insertSQL = `
          INSERT INTO authTokens (token, address, createdAt, validUntil, chainId) VALUES (?, ?, ?, ?, ?)
        `
    try {
      this.db.run(insertSQL, [token, address, createdAt, validUntil, chainId])
    } catch (err) {
      DATABASE_LOGGER.error(`Error creating auth token: ${err}`)
      throw err
    }
  }

  async validateTokenEntry(token: string): Promise<AuthToken | null> {
    const selectSQL = `
          SELECT * FROM authTokens WHERE token = ?
        `
    let row: AuthToken | undefined
    try {
      row = this.db.get<AuthToken>(selectSQL, [token])
    } catch (err) {
      DATABASE_LOGGER.error(`Error validating auth token: ${err}`)
      throw err
    }

    if (!row) {
      return null
    }

    if (!row.isValid) {
      return null
    }

    if (row.validUntil === null) {
      return row
    }

    const validUntilDate = new Date(row.validUntil).getTime()
    const now = Date.now()

    if (validUntilDate < now) {
      DATABASE_LOGGER.info(`Auth token ${token} is invalid`)
      await this.invalidateTokenEntry(token)
      return null
    }

    return row
  }

  // eslint-disable-next-line require-await
  async invalidateTokenEntry(token: string): Promise<void> {
    const deleteSQL = `
          UPDATE authTokens SET isValid = FALSE WHERE token = ?
        `
    try {
      this.db.run(deleteSQL, [token])
    } catch (err) {
      DATABASE_LOGGER.error(`Error invalidating auth token: ${err}`)
      throw err
    }
  }
}
