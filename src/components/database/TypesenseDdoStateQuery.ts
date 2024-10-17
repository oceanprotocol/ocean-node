import { IDdoStateQuery } from '../../@types/DDO/IDdoStateQuery.js'

export class TypesenseDdoStateQuery implements IDdoStateQuery {
  buildQuery(did?: string, nft?: string, txId?: string): Record<string, any> {
    let query: Record<string, any> = {}

    if (did) {
      query = {
        q: did,
        query_by: 'did'
      }
    }

    if (nft) {
      query = {
        q: nft,
        query_by: 'nft'
      }
    }

    if (txId) {
      query = {
        q: txId,
        query_by: 'txId'
      }
    }

    return query
  }
}
