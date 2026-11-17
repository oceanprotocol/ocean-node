import pg from 'pg'
import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import { DB_CONNECTION_EVENTS, DB_EVENTS } from '../connectionEvents.js'
import { SqlClient, toSqlValue } from './SqlClient.js'

const HEALTH_CHECK_INTERVAL_MS = 15_000

// the part of pg.Pool and pg.PoolClient that the client uses
type Queryable = Pick<pg.Pool, 'query'>

// PostgreSQL numbers its placeholders: `?` becomes `$1`, `$2`, ... Text in quotes stays.
export function numberPlaceholders(sql: string): string {
  let count = 0
  return sql.replace(/'(?:[^']|'')*'|"[^"]*"|\?/g, (match) =>
    match === '?' ? `$${++count}` : match
  )
}

// pg takes the user and the password from the connection string only, when it gets one.
// They are encoded: pg decodes them, so a "%41" in a password must not become an "A".
export function connectionString(config: OceanNodeDBConfig): string {
  const url = new URL(config.url)
  url.username = encodeURIComponent(config.username)
  url.password = encodeURIComponent(config.password)
  return url.toString()
}

// what the SQL stores must write in a different way on PostgreSQL
const DIALECT = {
  rowLock: ' FOR UPDATE',
  // the default collation of a database follows a language
  byteOrderText: 'TEXT COLLATE "C"'
}

function statements(queryable: Queryable) {
  const query = (sql: string, params: unknown[] = []) =>
    queryable.query(numberPlaceholders(sql), params.map(toSqlValue))
  return {
    ...DIALECT,
    exec: async (sql: string) => {
      await queryable.query(sql)
    },
    run: async (sql: string, params?: unknown[]) => ({
      changes: (await query(sql, params)).rowCount ?? 0
    }),
    get: async (sql: string, params?: unknown[]) => (await query(sql, params)).rows[0],
    all: async (sql: string, params?: unknown[]) => (await query(sql, params)).rows
  }
}

/**
 * PostgreSQL through a connection pool. Several node instances can use one database: a
 * transaction runs on one connection, and `rowLock` keeps a row for it.
 */
export class PostgresClient implements SqlClient {
  readonly rowLock = DIALECT.rowLock
  readonly byteOrderText = DIALECT.byteOrderText
  private pool: pg.Pool
  private healthTimer: NodeJS.Timeout
  private connected = true
  // runs each statement on a connection of the pool, outside a transaction
  private pooled: Omit<SqlClient, 'transaction' | 'close'>

  constructor(config: OceanNodeDBConfig) {
    this.pool = new pg.Pool({
      connectionString: connectionString(config),
      // a BIGINT comes as text by default; the values of the node fit in a number
      types: {
        getTypeParser: (id: number, format?: any) =>
          id === pg.types.builtins.INT8 ? Number : pg.types.getTypeParser(id, format)
      }
    })
    // an idle connection that the server closes must not stop the process
    this.pool.on('error', (error) => {
      DATABASE_LOGGER.error(`PostgreSQL connection error: ${error.message}`)
    })
    this.pooled = statements(this.pool)
    this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL_MS)
    this.healthTimer.unref()
  }

  exec(sql: string): Promise<void> {
    return this.pooled.exec(sql)
  }

  run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.pooled.run(sql, params)
  }

  get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return this.pooled.get<T>(sql, params)
  }

  all<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.pooled.all<T>(sql, params)
  }

  async transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect()
    const tx: SqlClient = {
      ...statements(connection),
      transaction: (nested) => nested(tx),
      close: () => Promise.resolve()
    }
    try {
      await connection.query('BEGIN')
      const result = await work(tx)
      await connection.query('COMMIT')
      return result
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      connection.release()
    }
  }

  async close(): Promise<void> {
    clearInterval(this.healthTimer)
    await this.pool.end()
  }

  // tells the node when the database goes away and comes back, so that the indexer stops
  // and starts again
  private async checkHealth(): Promise<void> {
    const alive = await this.pool.query('SELECT 1').then(
      () => true,
      () => false
    )
    if (alive === this.connected) return
    this.connected = alive
    if (alive) {
      DATABASE_LOGGER.info('PostgreSQL connection restored')
      DB_CONNECTION_EVENTS.emit(DB_EVENTS.CONNECTION_RESTORED)
    } else {
      DATABASE_LOGGER.warn('PostgreSQL connection lost')
      DB_CONNECTION_EVENTS.emit(DB_EVENTS.CONNECTION_LOST)
    }
  }
}
