export interface TypesenseAbstractLogger {
  error?: any
  warn?: any
  info?: any
  debug?: any
  trace?: any
}

export interface TypesenseNode {
  host: string
  port: string
  protocol: string
}

export interface TypesenseConfigOptions {
  apiKey: string
  nodes: TypesenseNode[]
  numRetries?: number
  retryIntervalSeconds?: number
  connectionTimeoutSeconds?: number
  logLevel?: string
  logger?: TypesenseAbstractLogger
}

export type TypesenseFieldType =
  | 'string'
  | 'int32'
  | 'int64'
  | 'float'
  | 'bool'
  | 'geopoint'
  | 'geopoint[]'
  | 'string[]'
  | 'int32[]'
  | 'int64[]'
  | 'float[]'
  | 'bool[]'
  | 'object'
  | 'object[]'
  | 'auto'
  | 'string*'

export interface TypesenseCollectionFieldSchema {
  name: string
  type: TypesenseFieldType
  optional?: boolean
  facet?: boolean
  index?: boolean
  sort?: boolean
  locale?: string
  infix?: boolean
  num_dim?: number
  [t: string]: unknown
}

export interface TypesenseCollectionCreateSchema {
  name: string
  enable_nested_fields?: boolean
  fields?: TypesenseCollectionFieldSchema[]
}

export interface TypesenseCollectionSchema extends TypesenseCollectionCreateSchema {
  created_at: number
  num_documents: number
  num_memory_shards: number
}

export interface TypesenseCollectionDropFieldSchema {
  name: string
  drop: true
}

export interface TypesenseCollectionUpdateSchema extends Partial<
  Omit<TypesenseCollectionCreateSchema, 'name' | 'fields'>
> {
  fields?: (TypesenseCollectionFieldSchema | TypesenseCollectionDropFieldSchema)[]
}

export type TypesenseDocumentSchema = Record<string, any>

type TypesenseOperationMode = 'off' | 'always' | 'fallback'

export interface TypesenseSearchParams {
  [key: string]: any
  // From https://typesense.org/docs/latest/api/documents.html#arguments
  q: string
  query_by: string | string[]
  query_by_weights?: string | number[]
  prefix?: string | boolean | boolean[] // default: true
  filter_by?: string
  sort_by?: string | string[] // default: text match desc
  facet_by?: string | string[]
  max_facet_values?: number
  facet_query?: string
  facet_query_num_typos?: number
  page?: number // default: 1
  per_page?: number // default: 10, max 250
  group_by?: string | string[]
  group_limit?: number // default:
  include_fields?: string | string[]
  exclude_fields?: string | string[]
  highlight_fields?: string | string[] // default: all queried fields
  highlight_full_fields?: string | string[] // default: all fields
  highlight_affix_num_tokens?: number // default: 4
  highlight_start_tag?: string // default: <mark>
  highlight_end_tag?: string // default: </mark>
  snippet_threshold?: number // default: 30
  num_typos?: string | number | number[] // default: 2
  min_len_1typo?: number
  min_len_2typo?: number
  split_join_tokens?: TypesenseOperationMode
  exhaustive_search?: boolean
  drop_tokens_threshold?: number // default: 10
  typo_tokens_threshold?: number // default: 100
  pinned_hits?: string | string[]
  hidden_hits?: string | string[]
  limit_hits?: number // default: no limit
  pre_segmented_query?: boolean
  enable_overrides?: boolean
  prioritize_exact_match?: boolean // default: true
  prioritize_token_position?: boolean
  search_cutoff_ms?: number
  use_cache?: boolean
  max_candidates?: number
  infix?: TypesenseOperationMode | TypesenseOperationMode[]
  preset?: string
  text_match_type?: 'max_score' | 'max_weight'
  vector_query?: string
  'x-typesense-api-key'?: string
  'x-typesense-user-id'?: string
  offset?: number
  limit?: number
}

export interface TypesenseSearchResponse {
  facet_counts?: any[]
  found: number
  found_docs?: number
  out_of: number
  page: number
  request_params: any
  search_time_ms: number
  hits?: any[]
  grouped_hits?: {
    group_key: string[]
    hits: any[]
    found?: number
  }[]
}
