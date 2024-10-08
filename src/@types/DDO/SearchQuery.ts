export interface FilterTerm {
  term?: { [key: string]: string | number | boolean }
  terms?: { [key: string]: (string | number | boolean)[] }
  range?: { [key: string]: { gte?: number; lte?: number } }
  bool?: any
  exists?: { field: string }
  match?: { [key: string]: string | number }
}

export interface BoolQuery {
  bool: {
    must?: FilterTerm[]
    must_not?: (FilterTerm | false | null | undefined)[]
    should?: FilterTerm[]
    filter?: FilterTerm[]
  }
}

export interface SearchQuery {
  q?: string
  filter_by?: any
  num_hits?: number
  start?: number
  sort_by?: string
  from?: number
  size?: number
  query?: any
  sort?: { [jsonPath: string]: string }
  aggs?: any
}

export interface BaseQueryParams {
  esPaginationOptions?: {
    from?: number
    size?: number
  }
  nestedQuery?: Partial<BoolQuery>
  filters?: FilterTerm[]
  chainIds?: number[]
  ignorePurgatory?: boolean
  ignoreState?: boolean
}
