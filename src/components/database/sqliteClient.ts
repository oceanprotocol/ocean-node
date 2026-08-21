import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'

type Bindable = string | number | bigint | Uint8Array | null

// node:sqlite refuses `undefined` and boolean bindings (throws ERR_INVALID_ARG_TYPE);
// the old `sqlite3` package silently coerced them. Keep that lenient behaviour centrally
// so every call site binds the same way it did before the engine swap.
function sanitize(v: unknown): Bindable {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  return v as Bindable
}

/**
 * Thin synchronous wrapper around Node's built-in `node:sqlite` (`DatabaseSync`).
 * Owns a single database handle per file and the sqlite3-compatibility concerns
 * (bind sanitization, eager parent-directory creation). This replaces the former
 * `sqlite3` native addon; all embedded DBs (nonce, config, C2D jobs, auth tokens,
 * persistent-storage registry) go through this client.
 *
 * The queries in this project are all single-row or small local-table operations, so
 * running them synchronously on the main thread is acceptable. Do not point this client
 * at large or unbounded datasets without reconsidering.
 */
export class SqliteClient {
  private db: DatabaseSync

  constructor(dbFilePath: string) {
    // DatabaseSync opens eagerly and throws synchronously if the parent directory is
    // missing (unlike the old sqlite3.Database, which deferred opening). mkdir here so
    // every DB path is covered uniformly and callers no longer need to mkdir themselves.
    fs.mkdirSync(path.dirname(dbFilePath), { recursive: true })
    this.db = new DatabaseSync(dbFilePath)
    // Long-running server process: wait briefly rather than fail if the DB is momentarily
    // locked (e.g. an external `sqlite3` CLI reading a live file).
    this.db.exec('PRAGMA busy_timeout = 5000;')
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  run(sql: string, params: unknown[] = []): { changes: number } {
    const result = this.db.prepare(sql).run(...params.map(sanitize))
    // readBigInts is not enabled, so `changes` is a JS number already; coerce to keep the
    // public type a plain number (all counts here are tiny, well below Number.MAX_SAFE_INTEGER).
    return { changes: Number(result.changes) }
  }

  get<T = any>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params.map(sanitize)) as T | undefined
  }

  all<T = any>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params.map(sanitize)) as T[]
  }
}
