import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'
import { SqlClient, toSqlValue } from './SqlClient.js'

const IN_MEMORY = ':memory:'

type Bindable = string | number | bigint | Uint8Array | null

const bind = (params: unknown[]) => params.map(toSqlValue) as Bindable[]

// runs a synchronous task and gives its result, or its throw, as a promise
function settle<T>(task: () => T): Promise<T> {
  return new Promise((resolve) => resolve(task()))
}

/**
 * SQLite through the built-in `node:sqlite`, one handle per file.
 *
 * `node:sqlite` is synchronous: a statement runs on the main thread. The calls go through a
 * queue, so the statements of a transaction are never mixed with the statements of another
 * caller that runs between two `await`s.
 */
export class SqliteClient implements SqlClient {
  // a transaction holds the write lock of the database from its start
  readonly rowLock = ''
  // the default of SQLite
  readonly byteOrderText = 'TEXT'
  private db: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()
  // the client that a transaction gives to its work: it runs at once, inside the queue slot
  // that the transaction holds
  private readonly direct: SqlClient = {
    rowLock: this.rowLock,
    byteOrderText: this.byteOrderText,
    exec: (sql) => settle(() => this.db.exec(sql)),
    run: (sql, params = []) => settle(() => this.runNow(sql, params)),
    get: (sql, params = []) =>
      settle(() => this.db.prepare(sql).get(...bind(params)) as any),
    all: (sql, params = []) =>
      settle(() => this.db.prepare(sql).all(...bind(params)) as any[]),
    transaction: (work) => work(this.direct),
    close: () => settle(() => this.db.close())
  }

  constructor(dbFilePath: string) {
    if (dbFilePath !== IN_MEMORY) {
      // DatabaseSync throws when the folder of the file does not exist
      fs.mkdirSync(path.dirname(dbFilePath), { recursive: true })
    }
    this.db = new DatabaseSync(dbFilePath)
    // WAL: a reader does not block the writer. busy_timeout: wait for a lock of another
    // process (for example the sqlite3 CLI on a live file) before the statement fails.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  }

  exec(sql: string): Promise<void> {
    return this.enqueue(() => this.direct.exec(sql))
  }

  run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.enqueue(() => this.direct.run(sql, params))
  }

  get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return this.enqueue(() => this.direct.get<T>(sql, params))
  }

  all<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.enqueue(() => this.direct.all<T>(sql, params))
  }

  // IMMEDIATE takes the write lock at the start, so a second process that shares the file
  // cannot commit between a read and a write of this transaction
  transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = await work(this.direct)
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        // SQLite ends the transaction itself on some errors (a full disk, for example)
        if (this.db.isTransaction) this.db.exec('ROLLBACK')
        throw error
      }
    })
  }

  close(): Promise<void> {
    return this.enqueue(() => this.direct.close())
  }

  private runNow(sql: string, params: unknown[]): { changes: number } {
    const result = this.db.prepare(sql).run(...bind(params))
    return { changes: Number(result.changes) }
  }

  // the task starts when all the tasks before it are done, whatever their result
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }
}
