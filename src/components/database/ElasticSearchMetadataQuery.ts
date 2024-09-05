import { SearchQuery } from './../../@types/DDO/SearchQuery.js'
import { IMetadataQuery } from '../../@types/DDO/IMetadataQuery.js'

export class ElasticSearchMetadataQuery implements IMetadataQuery {
  buildQuery(searchQuery: SearchQuery): Record<string, any> {
    if (this.isElasticSearchQuery(searchQuery)) {
      return searchQuery
    }
    const elasticsearchQuery: Record<string, any> = {
      from: searchQuery.start || 0,
      size: searchQuery.num_hits || 10,
      query: {
        bool: {
          filter: [],
          must_not: []
        }
      }
    }
    if (searchQuery.filter_by) {
      const filters = searchQuery.filter_by.split(' && ')
      filters.forEach((filter: string) => {
        let field, value
        if (filter.includes('!=')) {
          ;[field, value] = filter.split(':!=')
          elasticsearchQuery.query.bool.must_not.push({
            term: { [field]: value }
          })
        } else if (filter.includes(':=[')) {
          ;[field, value] = filter.split(':=[')
          const values = value.replace(']', '').split(',')
          elasticsearchQuery.query.bool.filter.push({
            terms: { [field]: values }
          })
        } else {
          ;[field, value] = filter.split(':=')
          elasticsearchQuery.query.bool.filter.push({
            term: { [field]: value }
          })
        }
      })
    }
    if (searchQuery.sort_by) {
      const [sortField, sortOrder] = searchQuery.sort_by.split(':')
      elasticsearchQuery.sort = [{ [sortField]: { order: sortOrder } }]
    }

    return elasticsearchQuery
  }

  private isElasticSearchQuery(query: any): boolean {
    return query && query.query && query.query.bool !== undefined
  }
}
