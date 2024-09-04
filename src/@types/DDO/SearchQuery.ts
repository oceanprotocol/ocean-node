export interface FilterTerm {
  [key: string]: string | number | boolean | string[] | number[]
}

export interface BoolQuery {
  bool: {
    must?: FilterTerm[]
    must_not?: (FilterTerm | false | null | undefined)[]
    should?: FilterTerm[]
    filter?: FilterTerm[]
  }
}

export enum SortDirectionOptions {
  // eslint-disable-next-line no-unused-vars
  Ascending = 'asc',
  // eslint-disable-next-line no-unused-vars
  Descending = 'desc'
}

export interface SearchQuery {
  from?: number
  size?: number
  query: BoolQuery
  sort?: { [jsonPath: string]: SortDirectionOptions }
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
