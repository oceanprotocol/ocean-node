import { IDdoStateQuery } from '../../@types/DDO/IDdoStateQuery.js'

export class ElasticSearchDdoStateQuery implements IDdoStateQuery {
  buildQuery(did?: string, nft?: string, txId?: string): Record<string, any> {
    let query: Record<string, any> = {}

    if (did) {
      query = {
        term: {
          did
        }
      }
    }

    if (nft) {
      query = {
        term: {
          nft
        }
      }
    }

    if (txId) {
      query = {
        term: {
          txId
        }
      }
    }

    return query
  }
}
