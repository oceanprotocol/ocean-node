import { SearchQuery } from './../../@types/DDO/SearchQuery'
import { IMetadataQuery } from '../../@types/DDO/IMetadataQuery'

export class ElasticSearchMetadataQuery implements IMetadataQuery {
  buildQuery(searchQuery: SearchQuery): Record<string, any> {
    const { query } = searchQuery
    const elasticsearchQuery: Record<string, any> = {
      from: searchQuery.from || 0,
      size: searchQuery.size || 10,
      query: {
        bool: {
          filter: [],
          must_not: []
        }
      }
    }

    if (query.bool) {
      if (query.bool.filter) {
        query.bool.filter.forEach((filter: any) => {
          if (filter.term) {
            elasticsearchQuery.query.bool.filter.push({
              term: filter.term
            })
          } else if (filter.terms) {
            elasticsearchQuery.query.bool.filter.push({
              terms: filter.terms
            })
          }
        })
      }

      if (query.bool.must_not) {
        query.bool.must_not.forEach((mustNot: any) => {
          if (mustNot.term) {
            elasticsearchQuery.query.bool.must_not.push({
              term: mustNot.term
            })
          } else if (mustNot.terms) {
            elasticsearchQuery.query.bool.must_not.push({
              terms: mustNot.terms
            })
          }
        })
      }
    }

    if (searchQuery.from !== undefined) {
      elasticsearchQuery.from = searchQuery.from
    }

    if (searchQuery.size !== undefined) {
      elasticsearchQuery.size = searchQuery.size
    }

    if (searchQuery.sort) {
      elasticsearchQuery.sort = searchQuery.sort
    }

    return elasticsearchQuery
  }
}
