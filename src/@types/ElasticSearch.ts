import {
  AggregationsAggregate,
  SearchResponse
} from '@elastic/elasticsearch/lib/api/types'

export interface ElasticSearchResponse
  extends SearchResponse<unknown, Record<string, AggregationsAggregate>> {
  schema?: string
}
