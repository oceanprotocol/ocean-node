import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { AbstractDdoStateDatabase, DdoStateKey } from '../BaseDatabase.js'
import type { SqlClient } from './SqlClient.js'
import { SqlDocuments } from './SqlDocuments.js'
import { orNull } from './orNull.js'

// the largest number of states that a search gives, as on Elasticsearch
const SEARCH_HITS = 10

// the result of the indexing of each DDO: id = the DID
export class SqlDdoStateDatabase extends AbstractDdoStateDatabase {
  private states: SqlDocuments

  constructor(config: OceanNodeDBConfig, db: SqlClient) {
    super(config)
    this.states = new SqlDocuments(db, 'ddo_state')
  }

  init(): Promise<void> {
    return this.states.init()
  }

  create(
    chainId: number,
    did: string,
    nftAddress: string,
    txId: string = ' ',
    valid: boolean = true,
    errorMsg: string = ' '
  ) {
    const state = { chainId, nft: nftAddress, txId, valid, error: errorMsg }
    return orNull(`Error when saving the ddo state of ${did}`, async () => {
      await this.states.put(did, { did, ...state })
      return { id: did, ...state }
    })
  }

  retrieve(did: string) {
    return orNull(`Error when retrieving the ddo state of ${did}`, () =>
      this.states.get(did)
    )
  }

  find(key: DdoStateKey) {
    const [field, value] = Object.entries(key)[0]
    return orNull('Error when searching the ddo states', async () => {
      const page = { offset: 0, limit: SEARCH_HITS }
      return (await this.states.find([{ paths: [field], anyOf: [value] }], [], page))
        .results
    })
  }

  update(
    chainId: number,
    did: string,
    nftAddress: string,
    txId?: string,
    valid?: boolean,
    errorMsg?: string
  ) {
    return this.create(chainId, did, nftAddress, txId, valid, errorMsg)
  }

  delete(did: string) {
    return orNull(`Error when deleting the ddo state of ${did}`, async () =>
      (await this.states.delete(did)) ? { id: did } : null
    )
  }
}
