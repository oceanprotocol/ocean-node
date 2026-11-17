import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import type { ConfigDatabase } from '../ConfigDatabase.js'
import type { SqlClient } from './SqlClient.js'

// node-wide key/value settings; a database error gives null, as the interface says
export class SqlConfigDatabase implements ConfigDatabase {
  constructor(private db: SqlClient) {}

  init(): Promise<void> {
    return this.db.exec(
      'CREATE TABLE IF NOT EXISTS config ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT)'
    )
  }

  async createOrUpdateConfig(key: string, value: string) {
    try {
      await this.db.run(
        `INSERT INTO config ("key", "value") VALUES (?, ?)
         ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`,
        [key, String(value)]
      )
      return { key, value }
    } catch (error) {
      DATABASE_LOGGER.error(`Error when writing config value ${key}: ${error.message}`)
      return null
    }
  }

  async retrieveValue(key: string) {
    try {
      const row = await this.db.get<{ value: string }>(
        'SELECT "value" FROM config WHERE "key" = ?',
        [key]
      )
      return { value: row?.value ?? null }
    } catch (error) {
      DATABASE_LOGGER.error(`Error when reading config value ${key}: ${error.message}`)
      return null
    }
  }
}
