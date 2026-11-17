import type { EscrowEvent } from '../../../@types/Escrow.js'
import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { AbstractEscrowDatabase } from '../BaseDatabase.js'
import { buildElasticQuery, escrowPage } from '../escrowSearch.js'
import type { SqlClient } from './SqlClient.js'
import { SqlDocuments } from './SqlDocuments.js'
import { orNull } from './orNull.js'

// the escrow events of the indexed chains: id = the event id
export class SqlEscrowDatabase extends AbstractEscrowDatabase {
  private events: SqlDocuments

  constructor(config: OceanNodeDBConfig, db: SqlClient) {
    super(config)
    this.events = new SqlDocuments(db, 'escrow', config.dbType)
  }

  init(): Promise<void> {
    return this.events.init()
  }

  create(event: EscrowEvent) {
    return orNull(`Error when creating escrow event ${event.id}`, async () => {
      await this.events.put(event.id, event)
      return event
    })
  }

  retrieve(id: string) {
    return orNull(`Error when retrieving escrow event ${id}`, () => this.events.get(id))
  }

  // a filter value is an equality value or a range on a number field
  search(filters: Record<string, any>, offset?: number, size?: number) {
    const page = escrowPage(offset, size)
    return orNull('Error when searching escrow events', () =>
      this.events.search({ query: buildElasticQuery(filters) }, page.limit, page.from)
    )
  }

  delete(id: string) {
    return orNull(`Error when deleting escrow event ${id}`, async () =>
      (await this.events.delete(id)) ? { id } : null
    )
  }
}
