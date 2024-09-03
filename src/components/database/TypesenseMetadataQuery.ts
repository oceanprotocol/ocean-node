import { IMetadataQuery } from '../../@types/DDO/IMetadataQuery'
import { SearchQuery } from '../../@types/DDO/SearchQuery'

export class TypesenseMetadataQuery implements IMetadataQuery {
  buildQuery(searchQuery: SearchQuery): Record<string, any> {
    const { query } = searchQuery
    // TODO implement custom logic?
    return query
  }
}
