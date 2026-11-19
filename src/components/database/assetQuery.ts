import { z } from 'zod'
import {
  Condition,
  DEFAULT_PAGE_SIZE,
  MAX_RESULT_WINDOW,
  Page,
  QueryError,
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
    'indexedMetadata.stats.symbol'
  ]
}

// the sort keys; `relevance` is the text score on Elasticsearch, `created` on SQL
export const SORT_FIELDS = {
  created: ['indexedMetadata.event.block'],
  orders: ['indexedMetadata.stats.orders'],
  price: ['indexedMetadata.stats.prices.price'],
  tokenSymbol: ['indexedMetadata.stats.symbol']
}
export const RELEVANCE = 'relevance'

// the nft state that the markets hide unless the query names the states
const REVOKED_STATE = 5

const strings = z.array(z.string())

const assetFilter = z
  .object({
    chainIds: z.array(z.number().int()).optional(),
    ids: strings.optional(),
    excludeIds: strings.optional(),
    excludeNftAddresses: strings.optional(),
    owners: strings.optional(),
    anyOf: z
      .object({ ids: strings.optional(), owners: strings.optional() })
      .strict()
      .optional(),
    types: z.array(z.enum(['dataset', 'algorithm'])).optional(),
    serviceTypes: z.array(z.enum(['access', 'compute'])).optional(),
    datatokenAddresses: strings.optional(),
    tags: strings.optional(),
    text: z.string().max(512).optional(),
    nftStates: z.array(z.number().int()).optional(),
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
  size: z.number().int().min(0).max(MAX_RESULT_WINDOW).default(DEFAULT_PAGE_SIZE)
}

const assetsRequest = z
  .object({
    type: z.literal('assets'),
    filter: assetFilter.default({}),
    sort: z
      .object({
        by: z.enum([...(Object.keys(SORT_FIELDS) as [string]), RELEVANCE]),
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
    size: z.number().int().min(1).max(MAX_RESULT_WINDOW).default(DEFAULT_PAGE_SIZE)
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
  const given = body
  if ('query' in given || 'from' in given || 'index' in given) {
    throw new QueryError(
      'The query of the node is { type, filter, sort, page, size }: an Elasticsearch ' +
        'query body is not accepted. See the DDO search section of docs/database.md'
    )
  }
  const parsed = queryRequest.safeParse({ type: 'assets', ...given })
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
  const anyOf = (paths: string[], values: unknown[] | undefined) =>
    values && conditions.push({ paths, anyOf: values as any[] })
  const noneOf = (paths: string[], values: unknown[] | undefined) =>
    values && conditions.push({ paths, noneOf: values as any[] })

  anyOf(f.chainId, filter.chainIds)
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
  if (filter.anyOf) {
    const either: Condition[] = []
    if (filter.anyOf.ids) either.push({ paths: f.id, anyOf: filter.anyOf.ids })
    if (filter.anyOf.owners) either.push({ paths: f.owner, anyOf: filter.anyOf.owners })
    if (either.length > 0) conditions.push({ either })
  }
  if (filter.nftStates) anyOf(f.nftState, filter.nftStates)
  else noneOf(f.nftState, [REVOKED_STATE])
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
  const words = (filter.text ?? '').split(/\s+/).filter(Boolean)
  if (words.length > 0) conditions.push({ paths: f.text, words })
  return conditions
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
