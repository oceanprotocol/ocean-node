import type { estypes } from '@elastic/elasticsearch'
import { addressCasingVariants } from '../../utils/evmAddress.js'
import type { Condition, Scalar, SortSpec } from './BaseDatabase.js'

type Query = estypes.QueryDslQueryContainer

// The DDO mappings (@oceanprotocol/ddo-js) do not name these fields, so Elasticsearch maps
// them itself: a text field, with a `.keyword` field that holds the exact value.
const DYNAMIC_TEXT = new Set([
  'indexedMetadata.nft.owner',
  'indexedMetadata.stats.prices.type',
  'indexedMetadata.stats.prices.price',
  'indexedMetadata.stats.symbol',
  'credentialSubject.dataspace'
])

// Exact values are case sensitive here, and the stored case of an address is not known:
// an address matches in each of its case forms.
const ADDRESS_PATHS = new Set([
  'nftAddress',
  'credentialSubject.nftAddress',
  'services.datatokenAddress',
  'credentialSubject.services.datatokenAddress',
  'indexedMetadata.nft.owner',
  'consumer',
  'payer'
])

// The DDO mappings make these objects `nested`: a query on a field below one of them runs
// in a `nested` query, or it never matches. The v5 trusted algorithms are not nested.
const NESTED_SCOPES = [
  'services',
  'services.compute.publisherTrustedAlgorithms',
  'credentialSubject.services'
]

const MATCH_ALL: Query = { match_all: {} }
const MATCH_NONE: Query = { match_none: {} }

// the field that holds the exact value of a path
function exact(path: string): string {
  return DYNAMIC_TEXT.has(path) ? `${path}.keyword` : path
}

// The query on a path, inside the nested scopes of the path, innermost first. The DDO
// indices of one search have different mappings, so a scope that an index does not have
// is ignored there.
function inScopes(path: string, query: Query): Query {
  return NESTED_SCOPES.filter((scope) => path.startsWith(`${scope}.`))
    .sort((a, b) => b.length - a.length)
    .reduce<Query>(
      (inner, scope) => ({
        nested: { path: scope, query: inner, ignore_unmapped: true }
      }),
      query
    )
}

function exactValues(path: string, values: Scalar[]): Scalar[] {
  if (!ADDRESS_PATHS.has(path)) return values
  return [...new Set(values.flatMap((value) => addressCasingVariants(String(value))))]
}

// one path of the field must hold
function onAnyPath(paths: string[], make: (path: string) => Query): Query {
  return paths.length === 1
    ? make(paths[0])
    : { bool: { should: paths.map(make), minimum_should_match: 1 } }
}

// one fixed clause for each kind of condition
export function esCondition(c: Condition): Query {
  if ('either' in c) {
    if (c.either.length === 0) return MATCH_NONE
    return { bool: { should: c.either.map(esCondition), minimum_should_match: 1 } }
  }
  const terms = (values: Scalar[]) => (path: string) =>
    inScopes(path, { terms: { [exact(path)]: exactValues(path, values) } })
  if ('anyOf' in c) {
    return c.anyOf.length === 0 ? MATCH_NONE : onAnyPath(c.paths, terms(c.anyOf))
  }
  if ('noneOf' in c) {
    if (c.noneOf.length === 0) return MATCH_ALL
    return { bool: { must_not: c.paths.map(terms(c.noneOf)) } }
  }
  if ('range' in c) {
    return onAnyPath(c.paths, (path) => inScopes(path, { range: { [path]: c.range } }))
  }
  if ('exists' in c) {
    return onAnyPath(c.paths, (path) => inScopes(path, { exists: { field: path } }))
  }
  // each word, as a word or the start of a word, in one of the fields
  return {
    bool: {
      filter: c.words.map((word) => ({
        multi_match: {
          query: word,
          fields: c.paths,
          type: 'phrase_prefix',
          lenient: true
        }
      }))
    }
  }
}

export function esQuery(conditions: Condition[]): Query {
  return conditions.length > 0
    ? { bool: { filter: conditions.map(esCondition) } }
    : MATCH_ALL
}

// `tieBreaker` is a keyword field with one value for each document, for a stable page
export function esSort(
  sort: SortSpec[],
  tieBreaker?: string
): estypes.SortCombinations[] {
  const keys: estypes.SortCombinations[] = sort.map(({ paths, order, relevance }) => {
    if (relevance) return { _score: { order: 'desc' } }
    const path = paths[0]
    return {
      [exact(path)]: {
        order,
        missing: '_last',
        unmapped_type: DYNAMIC_TEXT.has(path) ? 'keyword' : 'long'
      }
    }
  })
  return tieBreaker ? [...keys, { [tieBreaker]: { order: 'asc' } }] : keys
}

export function totalOf(total: number | estypes.SearchTotalHits | undefined): number {
  return typeof total === 'number' ? total : (total?.value ?? 0)
}
