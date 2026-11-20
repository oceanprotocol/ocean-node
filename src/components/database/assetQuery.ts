import { z } from 'zod'
import {
  Condition,
  MAX_RESULT_WINDOW,
  Page,
  QueryError,
  Scalar,
  SortSpec
} from './BaseDatabase.js'

// The query of the node: a typed request that every database runs with its own fixed
// queries. It has the searches that the markets use, and nothing more. See the "DDO
// search" section of docs/database.md.

// a DDO v4 path and the same field in a DDO v5 (`credentialSubject.`)
const inBoth = (path: string) => [path, `credentialSubject.${path}`]

// the places of each searchable DDO field
export const DDO_FIELDS = {
  id: ['id'],
  version: ['version'],
  chainId: inBoth('chainId'),
  nftAddress: inBoth('nftAddress'),
  owner: ['indexedMetadata.nft.owner'],
  type: inBoth('metadata.type'),
  serviceType: inBoth('services.type'),
  datatokenAddress: inBoth('services.datatokenAddress'),
  serviceEndpoint: inBoth('services.serviceEndpoint'),
  tags: inBoth('metadata.tags'),
  created: inBoth('metadata.created'),
  nftState: ['indexedMetadata.nft.state'],
  purgatory: ['indexedMetadata.purgatory.state'],
  priceType: ['indexedMetadata.stats.prices.type'],
  dataspace: ['credentialSubject.dataspace'],
  trustedAlgorithmDid: inBoth('services.compute.publisherTrustedAlgorithms.did'),
  trustedAlgorithmServiceId: inBoth(
    'services.compute.publisherTrustedAlgorithms.serviceId'
  ),
  trustedAlgorithmPublisher: inBoth(
    'services.compute.publisherTrustedAlgorithmPublishers'
  ),
  indexedMetadata: ['indexedMetadata'],
  // the fields of the text search
  text: [
    ...inBoth('metadata.name'),
    'metadata.description',
    'credentialSubject.metadata.description.value',
    ...inBoth('metadata.author'),
    ...inBoth('metadata.tags'),
    'indexedMetadata.stats.name',
    'indexedMetadata.stats.symbol',
    'indexedMetadata.nft.owner',
    'indexedMetadata.stats.datatokenAddress'
  ]
}

// the sort keys; `relevance` is the text score then `created` on Elasticsearch, `created`
// on SQL
export const SORT_FIELDS = {
  created: ['indexedMetadata.event.block'],
  orders: ['indexedMetadata.stats.orders'],
  price: ['indexedMetadata.stats.prices.price'],
  tokenSymbol: ['indexedMetadata.stats.symbol']
}
export const RELEVANCE = 'relevance'

// the nft state that the markets hide unless the query includes it
const UNLISTED_STATE = 5
// the page size when the request has none
const QUERY_PAGE_SIZE = 1000

const strings = z.array(z.string())

// the fields of an `anyOf` group
const ANY_OF_FIELDS = {
  ids: DDO_FIELDS.id,
  owners: DDO_FIELDS.owner,
  datatokenAddresses: DDO_FIELDS.datatokenAddress
}

const assetFilter = z
  .object({
    chainIds: z.array(z.number().int()).optional(),
    versions: strings.optional(),
    ids: strings.optional(),
    excludeIds: strings.optional(),
    excludeNftAddresses: strings.optional(),
    owners: strings.optional(),
    // each group holds when one of its lists matches; all groups must hold
    anyOf: z
      .array(
        z
          .object({
            ids: strings.optional(),
            owners: strings.optional(),
            datatokenAddresses: strings.optional()
          })
          .strict()
      )
      .optional(),
    types: z.array(z.enum(['dataset', 'algorithm'])).optional(),
    serviceTypes: z.array(z.enum(['access', 'compute'])).optional(),
    datatokenAddresses: strings.optional(),
    tags: strings.optional(),
    text: z.string().max(512).optional(),
    nftStates: z.array(z.number().int()).optional(),
    includeUnlisted: z.boolean().optional(),
    includePurgatory: z.boolean().optional(),
    priceTypes: strings.optional(),
    excludePriceTypes: strings.optional(),
    createdAfter: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO date')
      .optional(),
    serviceEndpoints: strings.optional(),
    dataspace: z.string().optional(),
    trustedAlgorithm: z
      .object({ did: z.string(), serviceId: z.string() })
      .strict()
      .optional(),
    trustedAlgorithmPublisher: z.string().optional(),
    indexedOnly: z.boolean().optional()
  })
  .strict()

export type AssetFilter = z.infer<typeof assetFilter>

const paging = {
  // starts at 1
  page: z.number().int().min(1).default(1),
  size: z.number().int().min(0).max(MAX_RESULT_WINDOW).default(QUERY_PAGE_SIZE)
}

const assetsRequest = z
  .object({
    type: z.literal('assets'),
    filter: assetFilter.default({}),
    sort: z
      .object({
        by: z.enum([RELEVANCE, ...Object.keys(SORT_FIELDS)] as [string, ...string[]]),
        order: z.enum(['asc', 'desc']).default('desc')
      })
      .strict()
      .optional(),
    ...paging
  })
  .strict()

const ordersRequest = z
  .object({
    type: z.literal('orders'),
    filter: z.union([
      z.object({ consumer: z.string() }).strict(),
      z.object({ payer: z.string() }).strict()
    ]),
    ...paging
  })
  .strict()

const tagsRequest = z
  .object({
    type: z.literal('tags'),
    filter: assetFilter.default({}),
    // the largest number of tags in the answer
    size: z.number().int().min(1).max(MAX_RESULT_WINDOW).default(QUERY_PAGE_SIZE)
  })
  .strict()

const queryRequest = z.discriminatedUnion('type', [
  assetsRequest,
  ordersRequest,
  tagsRequest
])

export type QueryRequest = z.infer<typeof queryRequest>
export type AssetsRequest = z.infer<typeof assetsRequest>

// the request of a caller, checked; throws QueryError (HTTP 400)
export function parseQueryRequest(body: unknown): QueryRequest {
  if (!isObject(body)) throw new QueryError('The query must be a JSON object')
  if ('query' in body || 'from' in body || 'index' in body) {
    throw new QueryError(
      'The query of the node is { type, filter, sort, page, size }: an Elasticsearch ' +
        'query body is not accepted. See the DDO search section of docs/database.md'
    )
  }
  const parsed = queryRequest.safeParse({ type: 'assets', ...body })
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
      .join('; ')
    throw new QueryError(`Invalid query: ${issues}`)
  }
  const request = parsed.data
  if ('page' in request && request.page * request.size > MAX_RESULT_WINDOW) {
    throw new QueryError(`A query reads the first ${MAX_RESULT_WINDOW} documents at most`)
  }
  return request
}

export function pageOf(request: { page: number; size: number }): Page {
  return { offset: (request.page - 1) * request.size, limit: request.size }
}

export function sortOf(sort: AssetsRequest['sort']): SortSpec[] {
  const { by, order } = sort ?? { by: 'created', order: 'desc' }
  // SQL has no text score: there, relevance gives the newest first
  if (by === RELEVANCE)
    return [{ paths: SORT_FIELDS.created, order: 'desc', relevance: true }]
  return [{ paths: SORT_FIELDS[by as keyof typeof SORT_FIELDS], order }]
}

// the conditions of an asset filter; unset fields add none
export function assetConditions(filter: AssetFilter): Condition[] {
  const f = DDO_FIELDS
  const conditions: Condition[] = []
  const anyOf = (paths: string[], values: Scalar[] | undefined) => {
    if (values) conditions.push({ paths, anyOf: values })
  }
  const noneOf = (paths: string[], values: Scalar[] | undefined) => {
    if (values) conditions.push({ paths, noneOf: values })
  }

  anyOf(f.chainId, filter.chainIds)
  anyOf(f.version, filter.versions)
  anyOf(f.id, filter.ids)
  noneOf(f.id, filter.excludeIds)
  noneOf(f.nftAddress, filter.excludeNftAddresses)
  anyOf(f.owner, filter.owners)
  anyOf(f.type, filter.types)
  anyOf(f.serviceType, filter.serviceTypes)
  anyOf(f.datatokenAddress, filter.datatokenAddresses)
  anyOf(f.tags, filter.tags)
  anyOf(f.priceType, filter.priceTypes)
  noneOf(f.priceType, filter.excludePriceTypes)
  anyOf(f.serviceEndpoint, filter.serviceEndpoints)
  for (const group of filter.anyOf ?? []) {
    const either = Object.entries(group).map(([field, values]) => ({
      paths: ANY_OF_FIELDS[field as keyof typeof ANY_OF_FIELDS],
      anyOf: values
    }))
    if (either.length > 0) conditions.push({ either })
  }
  anyOf(f.nftState, filter.nftStates)
  if (!filter.includeUnlisted) noneOf(f.nftState, [UNLISTED_STATE])
  if (!filter.includePurgatory) noneOf(f.purgatory, [true])
  if (filter.createdAfter) {
    conditions.push({ paths: f.created, range: { gte: filter.createdAfter } })
  }
  if (filter.dataspace !== undefined) anyOf(f.dataspace, [filter.dataspace])
  if (filter.trustedAlgorithm) {
    anyOf(f.trustedAlgorithmDid, [filter.trustedAlgorithm.did])
    anyOf(f.trustedAlgorithmServiceId, [filter.trustedAlgorithm.serviceId])
  }
  if (filter.trustedAlgorithmPublisher !== undefined) {
    anyOf(f.trustedAlgorithmPublisher, [filter.trustedAlgorithmPublisher])
  }
  if (filter.indexedOnly) conditions.push({ paths: f.indexedMetadata, exists: true })
  const text = filter.text?.trim()
  if (text) {
    // each word in the text fields, or the whole text is a DID
    const words: Condition = { paths: f.text, words: text.split(/\s+/) }
    conditions.push({ either: [words, { paths: f.id, anyOf: [text] }] })
  }
  return conditions
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
