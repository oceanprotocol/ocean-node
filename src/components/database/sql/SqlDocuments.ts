import { UnsupportedQueryError, queryPage } from '../BaseDatabase.js'
import { SqlClient, placeholders } from './SqlClient.js'
import {
  QueryTarget,
  numberOf,
  searchText,
  translateQuery,
  translateSort
} from './documentQuery.js'

type Document = Record<string, any>

interface FieldRow {
  path: string
  str: string
  num: number | null
}

// A longer path gets no field row: PostgreSQL limits the size of an index entry, and a
// path of this length is a free-form key, not a field that a query names.
const PATH_LIMIT = 128
// rows or ids for one statement; the databases limit the number of parameters
const CHUNK_SIZE = 200
// the parts of a node query
const QUERY_KEYS = ['query', 'sort', 'from', 'size', 'aggs', 'aggregations']

// One row for each leaf value of the document. The path has no array index: the path of
// the type of each service is "services.type".
export function flattenDocument(
  value: unknown,
  path: string = '',
  rows: FieldRow[] = []
): FieldRow[] {
  if (value === null || value === undefined) return rows
  if (Array.isArray(value)) {
    value.forEach((item) => flattenDocument(item, path, rows))
  } else if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      // PostgreSQL refuses U+0000 in a text, and the path is a text
      const name = key.replaceAll('\u0000', '')
      flattenDocument(child, path ? `${path}.${name}` : name, rows)
    }
  } else if (path.length <= PATH_LIMIT) {
    rows.push({ path, str: searchText(value), num: numberOf(value) })
  }
  return rows
}

/**
 * JSON documents in a SQL table, with a field table that makes them searchable with the
 * query of the node (see documentQuery.ts). Tables: `<table>` ("id", "doc") and
 * `<table>_fields` (one row for each leaf value of each document).
 */
export class SqlDocuments {
  private target: QueryTarget

  constructor(
    private db: SqlClient,
    private table: string,
    dbType: string
  ) {
    this.target = { fields: `${table}_fields`, dbType }
  }

  init(): Promise<void> {
    const { fields } = this.target
    return this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        "id" ${this.db.byteOrderText} PRIMARY KEY, "doc" TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${fields} (
        "id" ${this.db.byteOrderText} NOT NULL, "path" TEXT NOT NULL,
        "str" ${this.db.byteOrderText}, "num" DOUBLE PRECISION
      );
      CREATE INDEX IF NOT EXISTS ${fields}_id ON ${fields} ("id");
      CREATE INDEX IF NOT EXISTS ${fields}_str ON ${fields} ("path", "str");
      CREATE INDEX IF NOT EXISTS ${fields}_num ON ${fields} ("path", "num");`)
  }

  // `extraFields` are searchable but are not part of the document
  put(id: string, doc: Document, extraFields: Document = {}): Promise<void> {
    return this.db.transaction((tx) => this.write(tx, id, doc, extraFields))
  }

  get(id: string): Promise<Document | null> {
    return this.read(this.db, id)
  }

  // Reads the document (null when absent), applies `change` and writes the result, in one
  // transaction. `change` returns null to keep the document as it is.
  modify(
    id: string,
    change: (doc: Document | null) => Document | null
  ): Promise<Document | null> {
    return this.db.transaction(async (tx) => {
      // Only a row that exists can be locked. Without it, two callers that make the same
      // document at the same time both read "absent", and one change is lost. The JSON
      // null is the absent document.
      await tx.run(
        `INSERT INTO ${this.table} ("id", "doc") VALUES (?, 'null')
         ON CONFLICT ("id") DO NOTHING`,
        [id]
      )
      const current = await this.read(tx, id, tx.rowLock)
      const changed = change(current)
      if (changed) await this.write(tx, id, changed, {})
      else if (!current) await this.remove(tx, id)
      return changed
    })
  }

  delete(id: string): Promise<boolean> {
    return this.db.transaction((tx) => this.remove(tx, id))
  }

  // `query` and `sort` are the parts of a node query with these names
  async search(
    { query, sort }: { query?: Document; sort?: unknown },
    limit: number,
    offset: number
  ): Promise<Document[]> {
    const where = translateQuery(query, this.target)
    const order = translateSort(sort, this.target)
    const rows = await this.db.all(
      `SELECT d."id", d."doc" FROM ${this.table} d
       WHERE ${where.sql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
      [...where.params, ...order.params, limit, offset]
    )
    return rows.map(toDocument)
  }

  // Runs a node query: `query`, `sort`, `from` (a page number) and `size`. `aggs` is
  // accepted and not evaluated: the answer of the node holds documents only.
  async query(nodeQuery: Document): Promise<Document[]> {
    const unknown = Object.keys(nodeQuery).find((key) => !QUERY_KEYS.includes(key))
    if (unknown) throw new UnsupportedQueryError(unknown, this.target.dbType)
    const { size, offset } = queryPage(nodeQuery)
    return await this.search(nodeQuery, size, offset)
  }

  // returns the number of deleted documents
  deleteMatching(query: Document): Promise<number> {
    const where = translateQuery(query, this.target)
    const matching = `SELECT d."id" FROM ${this.table} d WHERE ${where.sql}`
    return this.db.transaction(async (tx) => {
      const ids = await tx.all<{ id: string }>(matching, where.params)
      for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
        const chunk = ids.slice(start, start + CHUNK_SIZE).map((row) => row.id)
        const list = placeholders(chunk.length)
        await tx.run(`DELETE FROM ${this.table} WHERE "id" IN (${list})`, chunk)
        await tx.run(`DELETE FROM ${this.target.fields} WHERE "id" IN (${list})`, chunk)
      }
      return ids.length
    })
  }

  private async read(db: SqlClient, id: string, lock = ''): Promise<Document | null> {
    const row = await db.get(
      `SELECT "id", "doc" FROM ${this.table} WHERE "id" = ?${lock}`,
      [id]
    )
    return row && row.doc !== 'null' ? toDocument(row) : null
  }

  private async write(
    tx: SqlClient,
    id: string,
    doc: Document,
    extraFields: Document
  ): Promise<void> {
    await tx.run(
      `INSERT INTO ${this.table} ("id", "doc") VALUES (?, ?)
       ON CONFLICT ("id") DO UPDATE SET "doc" = excluded."doc"`,
      [id, JSON.stringify(doc)]
    )
    await tx.run(`DELETE FROM ${this.target.fields} WHERE "id" = ?`, [id])
    // the id is a field too, so a query on "_id" works for a document with no id field
    const rows = flattenDocument({ id, ...doc, ...extraFields })
    for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
      await this.insertFields(tx, id, rows.slice(start, start + CHUNK_SIZE))
    }
  }

  private async insertFields(tx: SqlClient, id: string, rows: FieldRow[]): Promise<void> {
    await tx.run(
      `INSERT INTO ${this.target.fields} ("id", "path", "str", "num")
       VALUES ${rows.map(() => '(?, ?, ?, ?)').join(', ')}`,
      rows.flatMap((row) => [id, row.path, row.str, row.num])
    )
  }

  private async remove(tx: SqlClient, id: string): Promise<boolean> {
    await tx.run(`DELETE FROM ${this.target.fields} WHERE "id" = ?`, [id])
    const { changes } = await tx.run(`DELETE FROM ${this.table} WHERE "id" = ?`, [id])
    return changes === 1
  }
}

// the document, with its id when the document has no id field
function toDocument(row: { id: string; doc: string }): Document {
  const doc = JSON.parse(row.doc)
  if (!doc.id) doc.id = row.id
  return doc
}
