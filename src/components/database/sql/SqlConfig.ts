import type { ConfigDatabase } from '../ConfigDatabase.js'
import { orNull } from './orNull.js'
import type { SqlClient } from './SqlClient.js'

// node-wide key/value settings; a database error gives null, as the interface says
export class SqlConfigDatabase implements ConfigDatabase {
  constructor(private db: SqlClient) {}

  init(): Promise<void> {
    return this.db.exec(
      'CREATE TABLE IF NOT EXISTS config ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT)'
    )
  }

  createOrUpdateConfig(key: string, value: string) {
    return orNull(`Error when writing config value ${key}`, async () => {
      await this.db.run(
        `INSERT INTO config ("key", "value") VALUES (?, ?)
         ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`,
        [key, String(value)]
      )
      return { key, value }
    })
  }

  retrieveValue(key: string) {
    return orNull(`Error when reading config value ${key}`, async () => {
      const row = await this.db.get<{ value: string }>(
        'SELECT "value" FROM config WHERE "key" = ?',
        [key]
      )
      return { value: row?.value ?? null }
    })
  }
}
