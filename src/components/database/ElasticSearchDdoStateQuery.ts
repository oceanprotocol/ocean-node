import { IDdoStateQuery } from '../../@types/DDO/IDdoStateQuery.js'

export class ElasticSearchDdoStateQuery implements IDdoStateQuery {
  buildQuery(did?: string, nft?: string, txId?: string): Record<string, any> {
    let query: Record<string, any> = {}

    if (did) {
      query = {
        match: {
          did
        }
      }
    }

    if (nft) {
      query = {
        match: {
          nft
        }
      }
    }

    if (txId) {
      query = {
        match: {
          txId
        }
      }
    }

    return query
  }
}
