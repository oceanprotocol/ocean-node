import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import { AbstractDatabase } from './BaseDatabase.js'
import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { TypesenseSchema } from './TypesenseSchemas.js'
import path from 'path'
import * as fs from 'fs'
import { SQLiteAuthToken } from './sqliteAuthToken.js'

export interface AuthToken {
  token: string
  address: string
  created: Date
  validUntil: Date | null
  isValid: boolean
}

export class AuthTokenDatabase extends AbstractDatabase {
  private provider: SQLiteAuthToken

  constructor(config: OceanNodeDBConfig, schema: TypesenseSchema) {
    super(config, schema)
    return (async (): Promise<AuthTokenDatabase> => {
      DATABASE_LOGGER.info('Creating AuthTokenDatabase with SQLite')

      const dbDir = path.dirname('databases/authTokenDatabase.sqlite')
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true })
      }
      this.provider = new SQLiteAuthToken('databases/authTokenDatabase.sqlite')
      await this.provider.createTable()
      return this
    })() as unknown as AuthTokenDatabase
  }

  async createToken(
    token: string,
    address: string,
    validUntil: number | null = null,
    createdAt: number
  ): Promise<string> {
    await this.provider.createToken(token, address, createdAt, validUntil)
    return token
  }

  async validateToken(token: string): Promise<AuthToken | null> {
    const tokenEntry = await this.provider.validateTokenEntry(token)
    if (!tokenEntry) {
      return null
    }

    return tokenEntry
  }

  async deleteToken(token: string): Promise<void> {
    await this.provider.deleteTokenEntry(token)
  }
}
