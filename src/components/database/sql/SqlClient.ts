// The SQL stores talk to SQLite and PostgreSQL through this interface, so each store is
// written one time. A statement is valid on the two databases when it follows these rules:
//  - placeholders are `?`
//  - identifiers are in double quotes (PostgreSQL changes an unquoted name to lower case)
//  - column types are TEXT, BIGINT and DOUBLE PRECISION; a boolean is 0 or 1, JSON is TEXT
//  - no JSON function, no database-specific function
export interface SqlClient {
  // Put after a SELECT in a transaction that reads a row and then writes it: the row
  // stays locked until the transaction ends. Empty when the database locks without it.
  readonly rowLock: string
  // The type of a text column that is compared and sorted by its bytes, so that a text
  // search gives the same result and the same order on all databases.
  readonly byteOrderText: string
  // one or more statements with no parameters (schema changes)
  exec(sql: string): Promise<void>
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>
  get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>
  all<T = any>(sql: string, params?: unknown[]): Promise<T[]>
  // `work` gets a client that runs inside the transaction; a throw rolls back
  transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T>
  close(): Promise<void>
}

// The value of a parameter: the drivers refuse `undefined`, and a boolean is 0 or 1.
export function toSqlValue(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

// `?, ?, ?` for a list of values
export function placeholders(count: number): string {
  return Array(count).fill('?').join(', ')
}

export function insertRow(
  db: SqlClient,
  table: string,
  row: Record<string, unknown>
): Promise<{ changes: number }> {
  const columns = Object.keys(row)
  return db.run(
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${placeholders(columns.length)})`,
    Object.values(row)
  )
}

// The WHERE part of a statement, built from optional filters. All conditions must hold.
export class Conditions {
  readonly params: unknown[] = []
  private parts: string[] = []

  add(condition: string, ...params: unknown[]): this {
    this.parts.push(condition)
    this.params.push(...params)
    return this
  }

  // `"column" IN (...)`; no condition for an absent or empty list
  addIn(expression: string, values?: readonly unknown[]): this {
    if (!values || values.length === 0) return this
    return this.add(`${expression} IN (${placeholders(values.length)})`, ...values)
  }

  toString(): string {
    return this.parts.length > 0 ? ` WHERE ${this.parts.join(' AND ')}` : ''
  }
}
