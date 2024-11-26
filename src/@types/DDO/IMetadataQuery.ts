import { SearchQuery } from './SearchQuery'

export interface IMetadataQuery {
  buildQuery(query: SearchQuery): Record<string, any>
}
