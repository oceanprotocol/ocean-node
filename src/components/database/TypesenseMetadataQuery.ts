import { IMetadataQuery } from '../../@types/DDO/IMetadataQuery.js'
import { SearchQuery } from '../../@types/DDO/SearchQuery.js'

export class TypesenseMetadataQuery implements IMetadataQuery {
  buildQuery(searchQuery: SearchQuery): Record<string, any> {
    const { query } = searchQuery

    if (this.isTypesenseQuery(searchQuery)) {
      return searchQuery
    }

    const typesenseQuery: Record<string, any> = {
      q: '*',
      filter_by: '',
      num_hits: searchQuery.size || 10,
      start: searchQuery.from || 0
    }

    const filters: string[] = []
    if (query.bool.filter) {
      query.bool.filter.forEach((filter: any) => {
        if (filter.term) {
          const field = Object.keys(filter.term)[0]
          const value = filter.term[field]
          filters.push(`${field}:=${value}`)
        } else if (filter.terms) {
          const field = Object.keys(filter.terms)[0]
          const values = filter.terms[field].join(',')
          filters.push(`${field}:=[${values}]`)
        }
      })
    }

    if (query.bool && query.bool.must_not) {
      query.bool.must_not.forEach((mustNot: any) => {
        if (mustNot.term) {
          const field = Object.keys(mustNot.term)[0]
          const value = mustNot.term[field]
          filters.push(`${field}:!=${value}`)
        } else if (mustNot.terms) {
          const field = Object.keys(mustNot.terms)[0]
          const values = mustNot.terms[field].join(',')
          filters.push(`${field}:!=[${values}]`)
        }
      })
    }

    if (filters.length > 0) {
      typesenseQuery.filter_by = filters.join(' && ')
    }

    if (searchQuery.sort) {
      typesenseQuery.sort_by = Object.entries(searchQuery.sort)
        .map(([field, direction]: [string, string]) => {
          return `${field}:${direction}`
        })
        .join(',')
    }

    return typesenseQuery
  }

  private isTypesenseQuery(query: any): boolean {
    return query && query.filter_by !== undefined
  }
}
