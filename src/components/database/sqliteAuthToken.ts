import { AuthToken } from './AuthTokenDatabase.js'
import sqlite3 from 'sqlite3'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'

interface AuthTokenDatabaseProvider {
  createToken(
    token: string,
    address: string,
    createdAt: number,
    validUntil: number | null
  ): Promise<void>
  validateTokenEntry(token: string): Promise<AuthToken | null>
  deleteTokenEntry(token: string): Promise<void>
}

export class SQLiteAuthToken implements AuthTokenDatabaseProvider {
  private db: sqlite3.Database

  constructor(dbFilePath: string) {
    this.db = new sqlite3.Database(dbFilePath)
  }

  async createTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS authTokens (
        token TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        validUntil DATETIME
      )
    `)
  }

  async createToken(
    token: string,
    address: string,
    createdAt: number,
    validUntil: number | null = null
  ): Promise<void> {
    const insertSQL = `
          INSERT INTO authTokens (token, address, createdAt, validUntil) VALUES (?, ?, ?, ?)
        `
    return new Promise<void>((resolve, reject) => {
      this.db.run(insertSQL, [token, address, createdAt, validUntil], (err) => {
        if (err) {
          DATABASE_LOGGER.error(`Error creating auth token: ${err}`)
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  async validateTokenEntry(token: string): Promise<AuthToken | null> {
    const selectSQL = `
          SELECT * FROM authTokens WHERE token = ?
        `
    return new Promise<AuthToken | null>((resolve, reject) => {
      this.db.get(selectSQL, [token], (err, row: AuthToken) => {
        if (err) {
          DATABASE_LOGGER.error(`Error validating auth token: ${err}`)
          reject(err)
          return
        }

        if (!row) {
          resolve(null)
          return
        }

        if (row.validUntil === null) {
          resolve(row)
          return
        }

        const validUntilDate = new Date(row.validUntil).getTime()
        const now = Date.now()

        if (validUntilDate < now) {
          resolve(null)
          return
        }

        resolve(row)
      })
    })
  }

  async deleteTokenEntry(token: string): Promise<void> {
    const deleteSQL = `
          DELETE FROM authTokens WHERE token = ?
        `
    return new Promise<void>((resolve, reject) => {
      this.db.run(deleteSQL, [token], (err) => {
        if (err) {
          DATABASE_LOGGER.error(`Error deleting auth token: ${err}`)
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }
}
