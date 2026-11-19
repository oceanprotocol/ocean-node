import type { Condition, Found, Page, Scalar, SortSpec } from '../BaseDatabase.js'
import { SqlClient, placeholders } from './SqlClient.js'

type Document = Record<string, any>

interface FieldRow {
  path: string
  str: string
  num: number | null
}

interface SqlPart {
  sql: string
  params: unknown[]
}

// A longer path gets no field row: PostgreSQL limits the size of an index entry, and a
// path of this length is a free-form key, not a field that a search names.
const PATH_LIMIT = 128
// the longest text that a field row keeps; PostgreSQL limits the size of an index entry
const TEXT_LIMIT = 512
// rows or ids for one statement; the databases limit the number of parameters
const CHUNK_SIZE = 200
const MATCH_ALL: SqlPart = { sql: '1 = 1', params: [] }
const MATCH_NONE: SqlPart = { sql: '1 = 0', params: [] }
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/
const RANGE_OPERATORS = { gt: '>', gte: '>=', lt: '<', lte: '<=' }

// the value as the field table keeps it: lower case, so a comparison ignores the case
export function searchText(value: unknown): string {
  // PostgreSQL refuses U+0000 in a text, and a DDO would not be stored
  return String(value).toLowerCase().replaceAll('\u0000', '').slice(0, TEXT_LIMIT)
}

// the number that a value holds: a number, or a text such as '10' or '2.5'
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return typeof value === 'string' && NUMBER_TEXT.test(value) ? Number(value) : null
}

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
 * JSON documents in a SQL table, with a field table that makes them searchable with
 * conditions (see Condition in BaseDatabase.ts). Tables: `<table>` ("id", "doc") and
 * `<table>_fields` (one row for each leaf value of each document: its path, its value as
 * lower-case text, and its value as a number when it is one). A path has no array index,
 * so a field in an array matches when one element matches.
 */
export class SqlDocuments {
  private fields: string

  constructor(
    private db: SqlClient,
    private table: string
  ) {
    this.fields = `${table}_fields`
  }

  init(): Promise<void> {
    const { fields } = this
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

  // the documents that meet all conditions, sorted by `sort` and then by id
  async find(conditions: Condition[], sort: SortSpec[], page: Page): Promise<Found> {
    const where = this.where(conditions)
    const total = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS "count" FROM ${this.table} d WHERE ${where.sql}`,
      where.params
    )
    const totalResults = Number(total.count)
    if (page.limit === 0) return { results: [], totalResults }
    const order = this.orderBy(sort)
    const rows = await this.db.all(
      `SELECT d."id", d."doc" FROM ${this.table} d
       WHERE ${where.sql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
      [...where.params, ...order.params, page.limit, page.offset]
    )
    return { results: rows.map(toDocument), totalResults }
  }

  // the distinct values of a field (in lower case) in the documents that meet all
  // conditions, with the number of documents for each, the most frequent first
  async valueCounts(
    paths: string[],
    conditions: Condition[],
    limit: number
  ): Promise<{ value: string; count: number }[]> {
    const where = this.where(conditions)
    const rows = await this.db.all<{ value: string; count: number }>(
      `SELECT f."str" AS "value", COUNT(DISTINCT f."id") AS "count" FROM ${this.fields} f
       WHERE f."path" IN (${placeholders(paths.length)})
         AND f."id" IN (SELECT d."id" FROM ${this.table} d WHERE ${where.sql})
       GROUP BY f."str" ORDER BY "count" DESC, "value" ASC LIMIT ?`,
      [...paths, ...where.params, limit]
    )
    return rows.map((row) => ({ value: row.value, count: Number(row.count) }))
  }

  // returns the number of deleted documents
  deleteMatching(conditions: Condition[]): Promise<number> {
    const where = this.where(conditions)
    const matching = `SELECT d."id" FROM ${this.table} d WHERE ${where.sql}`
    return this.db.transaction(async (tx) => {
      const ids = await tx.all<{ id: string }>(matching, where.params)
      for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
        const chunk = ids.slice(start, start + CHUNK_SIZE).map((row) => row.id)
        const list = placeholders(chunk.length)
        await tx.run(`DELETE FROM ${this.table} WHERE "id" IN (${list})`, chunk)
        await tx.run(`DELETE FROM ${this.fields} WHERE "id" IN (${list})`, chunk)
      }
      return ids.length
    })
  }

  // ── one fixed SQL form for each kind of condition ─────────────────────

  private where(conditions: Condition[]): SqlPart {
    return conditions.length > 0
      ? join(
          conditions.map((condition) => this.condition(condition)),
          ' AND '
        )
      : MATCH_ALL
  }

  private condition(c: Condition): SqlPart {
    if ('either' in c) {
      if (c.either.length === 0) return MATCH_NONE
      return wrap(
        '(',
        join(
          c.either.map((part) => this.condition(part)),
          ' OR '
        ),
        ')'
      )
    }
    const inPaths = {
      sql: `"path" IN (${placeholders(c.paths.length)})`,
      params: c.paths
    }
    if ('anyOf' in c || 'noneOf' in c) {
      const values = 'anyOf' in c ? c.anyOf : c.noneOf
      if (values.length === 0) return 'anyOf' in c ? MATCH_NONE : MATCH_ALL
      const equal = this.hasField(inPaths, {
        sql: `"str" IN (${placeholders(values.length)})`,
        params: values.map(searchText)
      })
      return 'anyOf' in c ? equal : wrap('NOT (', equal, ')')
    }
    if ('range' in c) {
      const bounds = Object.entries(c.range)
        .filter(([, bound]) => bound !== undefined)
        .map(([key, bound]) =>
          compare(RANGE_OPERATORS[key as keyof typeof RANGE_OPERATORS], bound)
        )
      return this.hasField(inPaths, ...bounds)
    }
    if ('exists' in c) {
      // the field itself, or a field below it
      const below = c.paths.map(() => `"path" LIKE ? ESCAPE '\\'`).join(' OR ')
      return this.hasField({
        sql: `(${inPaths.sql} OR ${below})`,
        params: [...c.paths, ...c.paths.map((path) => `${escapeLike(path)}.%`)]
      })
    }
    return join(
      c.words.map((word) =>
        this.hasField(inPaths, {
          sql: `"str" LIKE ? ESCAPE '\\'`,
          params: [`%${escapeLike(searchText(word))}%`]
        })
      ),
      ' AND '
    )
  }

  // the documents that have a field row for which all parts hold
  private hasField(...parts: SqlPart[]): SqlPart {
    const row = join(parts, ' AND ')
    return {
      sql: `d."id" IN (SELECT "id" FROM ${this.fields} WHERE ${row.sql})`,
      params: row.params
    }
  }

  // A document can have several values for a field: the lowest one counts for an
  // ascending sort, the highest one for a descending sort. The number comes before the
  // text, so a number field sorts as a number. A document without the field is last.
  private orderBy(sort: SortSpec[]): SqlPart {
    const parts = sort.map(({ paths, order }) => {
      const [pick, direction] = order === 'desc' ? ['MAX', 'DESC'] : ['MIN', 'ASC']
      const value = (column: string) =>
        `(SELECT ${pick}("${column}") FROM ${this.fields} f
          WHERE f."id" = d."id" AND f."path" IN (${placeholders(paths.length)}))
          ${direction} NULLS LAST`
      return { sql: `${value('num')}, ${value('str')}`, params: [...paths, ...paths] }
    })
    return join([...parts, { sql: 'd."id" ASC', params: [] }], ', ')
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
    await tx.run(`DELETE FROM ${this.fields} WHERE "id" = ?`, [id])
    // the id is a field too, so a query on "_id" works for a document with no id field
    const rows = flattenDocument({ id, ...doc, ...extraFields })
    for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
      await this.insertFields(tx, id, rows.slice(start, start + CHUNK_SIZE))
    }
  }

  private async insertFields(tx: SqlClient, id: string, rows: FieldRow[]): Promise<void> {
    await tx.run(
      `INSERT INTO ${this.fields} ("id", "path", "str", "num")
       VALUES ${rows.map(() => '(?, ?, ?, ?)').join(', ')}`,
      rows.flatMap((row) => [id, row.path, row.str, row.num])
    )
  }

  private async remove(tx: SqlClient, id: string): Promise<boolean> {
    await tx.run(`DELETE FROM ${this.fields} WHERE "id" = ?`, [id])
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

// A bound that is a number is compared as a number with the values that are numbers, and
// as text with the other values: an ISO date is compared as text.
function compare(operator: string, bound: Scalar): SqlPart {
  const asText = { sql: `"str" ${operator} ?`, params: [searchText(bound)] }
  const number = numberOf(bound)
  if (number === null) return asText
  return {
    sql: `(("num" IS NOT NULL AND "num" ${operator} ?) OR ("num" IS NULL AND ${asText.sql}))`,
    params: [number, ...asText.params]
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function join(parts: SqlPart[], separator: string): SqlPart {
  return {
    sql: parts.map((part) => part.sql).join(separator),
    params: parts.flatMap((part) => part.params)
  }
}

function wrap(before: string, part: SqlPart, after: string): SqlPart {
  return { sql: `${before}${part.sql}${after}`, params: part.params }
}
