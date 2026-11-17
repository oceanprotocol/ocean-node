import { QueryError, UnsupportedQueryError } from '../BaseDatabase.js'
import { placeholders } from './SqlClient.js'

// Translates the query of the node (the Elasticsearch format) to SQL for a document table
// `d` with a field table: one row ("id", "path", "str", "num") for each leaf value of a
// document. "str" is the value as lower-case text, "num" the value when it is a number.
// A path has no array index, so a field in an array matches when one element matches.
//
// Supported: bool (must, filter, should, must_not), term, terms, match, match_phrase,
// range, exists, match_all and a simplified query_string. All other clauses and options
// throw UnsupportedQueryError.
//
// The query comes from a public caller. Its values go to the SQL parameters only, never to
// the SQL text; a part with a wrong type throws QueryError; its size has limits.

export interface SqlPart {
  sql: string
  params: unknown[]
}

export interface QueryTarget {
  // the name of the field table
  fields: string
  // for the error message
  dbType: string
}

// one translation: the target, and the number of conditions that the query has used
interface Translation extends QueryTarget {
  conditions: number
}

type Clause = Record<string, unknown>
type Scalar = string | number | boolean
type Translator = (body: unknown, t: Translation, depth: number) => SqlPart

// the longest text that a field row keeps; PostgreSQL limits the size of an index entry
const TEXT_LIMIT = 512
// Each condition is one subquery on the field table, and a text search reads the full
// table. Elasticsearch limits the clauses and the nesting of a query too.
const MAX_CONDITIONS = 1024
const MAX_DEPTH = 20
const MAX_SORT_FIELDS = 8

const MATCH_ALL: SqlPart = { sql: '1 = 1', params: [] }
const MATCH_NONE: SqlPart = { sql: '1 = 0', params: [] }
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/
const RANGE_OPERATORS = new Map([
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<=']
])
// the options that change the score only: SQL has no score
const SCORE_ONLY = ['boost']
const BOOL_KEYS = ['must', 'filter', 'should', 'must_not', 'minimum_should_match']
// the last three change which words must match on Elasticsearch; they are not evaluated
const QUERY_STRING_OPTIONS = [
  'query',
  'fields',
  'default_field',
  'default_operator',
  'lenient',
  'phrase_slop',
  'minimum_should_match'
]
// The operators of the query_string syntax that are not evaluated: NOT, +word, -word,
// !word, field:word, word~, wor?d, word^2, && and ||. A client escapes them in the text of
// a user with a backslash.
const QUERY_STRING_OPERATORS = /(^|\s)(NOT(\s|$)|[+\-!])|[:~?^]|&&|\|\|/

export function translateQuery(clause: unknown, target: QueryTarget): SqlPart {
  return translateClause(clause ?? {}, { ...target, conditions: 0 }, 0)
}

// `sort` of the query: "field", { field: "desc" }, { field: { order: "desc" } }, or an
// array of these. The result ends with the id, so the order is stable for paging.
export function translateSort(sort: unknown, target: QueryTarget): SqlPart {
  const entries = sortEntries(sort, target.dbType)
    // SQL has no relevance: these two give no order
    .filter(([field]) => field !== '_score' && field !== '_doc')
  if (entries.length > MAX_SORT_FIELDS) {
    throw new QueryError(`A query sorts on ${MAX_SORT_FIELDS} fields at most`)
  }
  const parts = entries.map(([field, order]) => sortBy(fieldName(field), order, target))
  return join([...parts, { sql: 'd."id" ASC', params: [] }], ', ')
}

// the value as the field table keeps it
export function searchText(value: unknown): string {
  return String(value).toLowerCase().slice(0, TEXT_LIMIT)
}

// the number that a value holds: a number, or a text such as '10' or '2.5'
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return typeof value === 'string' && NUMBER_TEXT.test(value) ? Number(value) : null
}

// a Map: a lookup on an object also finds the names of Object.prototype ("constructor")
const TRANSLATORS = new Map<string, Translator>([
  ['match_all', () => MATCH_ALL],
  ['bool', bool],
  ['term', (body, t) => equals(t, ...fieldAndValue('term', body, 'value', t))],
  ['terms', terms],
  ['match', (body, t) => contains(t, ...fieldAndValue('match', body, 'query', t))],
  [
    'match_phrase',
    (body, t) => contains(t, ...fieldAndValue('match_phrase', body, 'query', t))
  ],
  ['range', range],
  ['exists', exists],
  ['query_string', queryString]
])

// a clause is an object with one key: its name
function translateClause(clause: unknown, t: Translation, depth: number): SqlPart {
  const entries = Object.entries(object('query', clause))
  if (entries.length === 0) return MATCH_ALL
  if (entries.length > 1) {
    throw new QueryError(`A query clause has one name, not ${entries.length}`)
  }
  const [name, body] = entries[0]
  const translator = TRANSLATORS.get(name)
  if (!translator) throw new UnsupportedQueryError(name, t.dbType)
  return translator(body, t, depth)
}

function bool(body: unknown, t: Translation, depth: number): SqlPart {
  if (depth >= MAX_DEPTH) {
    throw new QueryError(`A query has ${MAX_DEPTH} levels of bool at most`)
  }
  const parts = options('bool', body, BOOL_KEYS, t.dbType)
  const translate = (list: unknown) =>
    clauses(list).map((clause) => translateClause(clause, t, depth + 1))
  const required = [...translate(parts.must), ...translate(parts.filter)]
  const excluded = translate(parts.must_not).map((part) => wrap('NOT (', part, ')'))
  const optional = translate(parts.should)
  const all = [...required, ...excluded]
  const shouldRequired = shouldIsRequired(parts.minimum_should_match, required.length, t)
  if (shouldRequired && optional.length > 0) {
    all.push(wrap('(', join(optional, ' OR '), ')'))
  }
  return all.length > 0 ? join(all, ' AND ') : MATCH_ALL
}

// `should` must match when it is alone, or when minimum_should_match is 1
function shouldIsRequired(minimum: unknown, requiredCount: number, t: Translation) {
  if (minimum === undefined || Number(minimum) === 0) return requiredCount === 0
  if (Number(minimum) === 1) return true
  throw new UnsupportedQueryError('minimum_should_match', t.dbType)
}

function equals(t: Translation, field: string, value: Scalar): SqlPart {
  return hasField(t, '"path" = ? AND "str" = ?', [field, searchText(value)])
}

// the text is inside the value; a number or a boolean must be equal
function contains(t: Translation, field: string, value: Scalar): SqlPart {
  if (typeof value !== 'string') return equals(t, field, value)
  return hasField(t, `"path" = ? AND "str" LIKE ? ESCAPE '\\'`, [field, like(value)])
}

function terms(body: unknown, t: Translation): SqlPart {
  const [field, values] = fieldEntry('terms', body)
  // an object in place of the list is a terms lookup: it reads a document of another index
  if (!Array.isArray(values)) throw new UnsupportedQueryError('terms lookup', t.dbType)
  if (values.length === 0) return MATCH_NONE
  countConditions(t, values.length)
  return hasField(t, `"path" = ? AND "str" IN (${placeholders(values.length)})`, [
    fieldName(field),
    ...values.map((value) => searchText(scalar('terms', value)))
  ])
}

// all bounds must hold for the same value
function range(body: unknown, t: Translation): SqlPart {
  const [field, given] = fieldEntry('range', body)
  const bounds = options('range', given, [...RANGE_OPERATORS.keys()], t.dbType)
  const parts = Object.entries(bounds)
    .filter(([key]) => RANGE_OPERATORS.has(key))
    .map(([key, bound]) => compare(RANGE_OPERATORS.get(key), scalar('range', bound)))
  const all = join([{ sql: '"path" = ?', params: [fieldName(field)] }, ...parts], ' AND ')
  return hasField(t, all.sql, all.params)
}

// A bound that is a number is compared as a number with the values that are numbers, and
// as text with the other values: a year ('2022') is a valid bound for an ISO date.
function compare(operator: string, bound: Scalar): SqlPart {
  const asText = { sql: `"str" ${operator} ?`, params: [searchText(bound)] }
  const number = numberOf(bound)
  if (number === null) return asText
  return {
    sql: `(("num" IS NOT NULL AND "num" ${operator} ?) OR ("num" IS NULL AND ${asText.sql}))`,
    params: [number, ...asText.params]
  }
}

// a leaf field, or an object that has leaf fields below it
function exists(body: unknown, t: Translation): SqlPart {
  const { field } = options('exists', body, ['field'], t.dbType)
  if (typeof field !== 'string') {
    throw new QueryError("Query clause 'exists' needs the name of a field")
  }
  const path = fieldName(field)
  return hasField(t, `("path" = ? OR "path" LIKE ? ESCAPE '\\')`, [
    path,
    `${escapeLike(path)}.%`
  ])
}

// A simplified query_string: the words of the text, with AND or OR between them. A word
// matches when a value of one of the fields contains it. Wildcards, quotes and
// parentheses are removed; the other operators are refused.
function queryString(body: unknown, t: Translation): SqlPart {
  const given = options('query_string', body, QUERY_STRING_OPTIONS, t.dbType)
  const query = String(given.query ?? '')
  // an operator after a backslash is text
  if (QUERY_STRING_OPERATORS.test(query.replace(/\\./g, ''))) {
    throw new UnsupportedQueryError('query_string operator', t.dbType)
  }
  const tokens = query
    .replace(/[\\*"()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const words = tokens.filter((token) => token !== 'AND' && token !== 'OR')
  if (words.length === 0) return MATCH_ALL
  const fields = queryStringFields(given)
  if (fields.some((field) => field.includes('*'))) {
    throw new UnsupportedQueryError('query_string field pattern', t.dbType)
  }
  const inFields =
    fields.length > 0 ? `"path" IN (${placeholders(fields.length)}) AND ` : ''
  const parts = words.map((word) =>
    hasField(t, `${inFields}"str" LIKE ? ESCAPE '\\'`, [...fields, like(word)])
  )
  const allWords =
    tokens.includes('AND') ||
    (!tokens.includes('OR') && String(given.default_operator).toUpperCase() === 'AND')
  return wrap('(', join(parts, allWords ? ' AND ' : ' OR '), ')')
}

// `fields` can give a boost: "metadata.name^10". No field means all fields.
function queryStringFields(given: Clause): string[] {
  const fields = given.fields ?? [given.default_field].filter((f) => f !== undefined)
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== 'string')) {
    throw new QueryError("'fields' of query_string must be a list of field names")
  }
  return fields.map((field: string) => fieldName(field.split('^')[0]))
}

function sortEntries(sort: unknown, dbType: string): [string, string][] {
  if (sort === undefined || sort === null) return []
  if (typeof sort === 'string') return [[sort, 'asc']]
  if (Array.isArray(sort)) return sort.flatMap((entry) => sortEntries(entry, dbType))
  return Object.entries(object('sort', sort)).map(([field, option]) => [
    field,
    sortOrder(option, dbType)
  ])
}

// "desc" or { order: "desc" }
function sortOrder(option: unknown, dbType: string): string {
  const order = isObject(option)
    ? (options('sort', option, ['order'], dbType).order ?? 'asc')
    : option
  if (order !== 'asc' && order !== 'desc') {
    throw new QueryError("The order of a sort is 'asc' or 'desc'")
  }
  return order
}

// A document can have several values for a field: the lowest one counts for an ascending
// sort, the highest one for a descending sort. The number comes before the text, so a
// number field sorts as a number. A document without the field is last.
function sortBy(field: string, order: string, target: QueryTarget): SqlPart {
  const [pick, direction] = order === 'desc' ? ['MAX', 'DESC'] : ['MIN', 'ASC']
  const value = (column: string) =>
    `(SELECT ${pick}("${column}") FROM ${target.fields} f
      WHERE f."id" = d."id" AND f."path" = ?) ${direction} NULLS LAST`
  return { sql: `${value('num')}, ${value('str')}`, params: [field, field] }
}

// ── the parts of a clause ───────────────────────────────────────────

// the documents that have a row in the field table for which `condition` holds
function hasField(t: Translation, condition: string, params: unknown[]): SqlPart {
  countConditions(t, 1)
  return {
    sql: `d."id" IN (SELECT "id" FROM ${t.fields} WHERE ${condition})`,
    params
  }
}

function countConditions(t: Translation, conditions: number): void {
  t.conditions += conditions
  if (t.conditions > MAX_CONDITIONS) {
    throw new QueryError(`A query has ${MAX_CONDITIONS} conditions at most`)
  }
}

// ".keyword" selects the exact form of a field on Elasticsearch; here it is the same field
function fieldName(name: string): string {
  return name === '_id' ? 'id' : name.replace(/\.keyword$/, '')
}

// { field: value } or { field: { [valueKey]: value } }
function fieldAndValue(
  clause: string,
  body: unknown,
  valueKey: string,
  t: Translation
): [string, Scalar] {
  const [field, given] = fieldEntry(clause, body)
  const value = isObject(given)
    ? options(clause, given, [valueKey], t.dbType)[valueKey]
    : given
  return [fieldName(field), scalar(clause, value)]
}

// the field of a clause and what the clause says about it
function fieldEntry(clause: string, body: unknown): [string, unknown] {
  const entries = Object.entries(object(clause, body)).filter(
    ([key]) => !SCORE_ONLY.includes(key)
  )
  if (entries.length !== 1) {
    throw new QueryError(`Query clause '${clause}' takes one field`)
  }
  return entries[0]
}

// the body of a clause: an object with the allowed keys; a key is refused, never ignored
function options(
  clause: string,
  body: unknown,
  allowed: string[],
  dbType: string
): Clause {
  const given = object(clause, body)
  const unknown = Object.keys(given).find(
    (key) => !allowed.includes(key) && !SCORE_ONLY.includes(key)
  )
  if (unknown !== undefined) {
    throw new UnsupportedQueryError(`${clause}.${unknown}`, dbType)
  }
  return given
}

function isObject(value: unknown): value is Clause {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(clause: string, value: unknown): Clause {
  if (!isObject(value)) throw new QueryError(`Query clause '${clause}' must be an object`)
  return value
}

function scalar(clause: string, value: unknown): Scalar {
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new QueryError(
      `Query clause '${clause}' needs a text, a number or a boolean as value`
    )
  }
  return value as Scalar
}

// one clause or an array of clauses; a client can send null and false entries
function clauses(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : [value]).filter(Boolean)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function like(value: string): string {
  return `%${escapeLike(searchText(value))}%`
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
