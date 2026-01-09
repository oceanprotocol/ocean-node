import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { AbstractDatabase } from './BaseDatabase.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import path from 'path'
import * as fs from 'fs'
import { SQLiteAuthToken } from './sqliteAuthToken.js'

export interface AuthToken {
  token: string
  address: string
  created: Date
  validUntil: Date | null
  isValid: boolean
  chainId?: string | null
}

export class AuthTokenDatabase extends AbstractDatabase {
  private provider: SQLiteAuthToken

  private constructor(config: OceanNodeDBConfig, provider?: SQLiteAuthToken) {
    super(config)
    this.provider = provider
  }

  static async create(config: OceanNodeDBConfig): Promise<AuthTokenDatabase> {
    DATABASE_LOGGER.info('Creating AuthTokenDatabase with SQLite')
    const dbDir = path.dirname('databases/authTokenDatabase.sqlite')
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    const provider = new SQLiteAuthToken('databases/authTokenDatabase.sqlite')
    await provider.createTable()
    return new AuthTokenDatabase(config, provider)
  }

  async createToken(
    token: string,
    address: string,
    validUntil: number | null = null,
    createdAt: number,
    chainId?: string | null
  ): Promise<string> {
    await this.provider.createToken(token, address, createdAt, validUntil, chainId)
    return token
  }

  async validateToken(token: string): Promise<AuthToken | null> {
    const tokenEntry = await this.provider.validateTokenEntry(token)
    if (!tokenEntry) {
      return null
    }

    return tokenEntry
  }

  async invalidateToken(token: string): Promise<void> {
    await this.provider.invalidateTokenEntry(token)
  }
}
