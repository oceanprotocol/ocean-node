import lodash from 'lodash'
import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { AbstractOrderDatabase } from '../BaseDatabase.js'
import type { SqlClient } from './SqlClient.js'
import { SqlDocuments } from './SqlDocuments.js'
import { orNull } from './orNull.js'

// the orders of the indexed chains: id = the order transaction
export class SqlOrderDatabase extends AbstractOrderDatabase {
  private orders: SqlDocuments

  constructor(config: OceanNodeDBConfig, db: SqlClient) {
    super(config)
    // "order" is a reserved word in SQL
    this.orders = new SqlDocuments(db, 'orders', config.dbType)
  }

  init(): Promise<void> {
    return this.orders.init()
  }

  search(query: Record<string, any>) {
    return orNull('Error when searching orders', () => this.orders.query(query))
  }

  create(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    datatokenAddress: string,
    nftAddress: string,
    did: string,
    startOrderId?: string
  ) {
    const order = {
      orderId,
      type,
      timestamp,
      consumer,
      payer,
      datatokenAddress,
      nftAddress,
      did,
      startOrderId
    }
    return orNull(`Error when creating order ${orderId}`, async () => {
      await this.orders.put(orderId, order)
      return order
    })
  }

  retrieve(orderId: string) {
    return orNull(`Error when retrieving order ${orderId}`, () =>
      this.orders.get(orderId)
    )
  }

  // changes the given fields only; creates the order when it does not exist
  update(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    startOrderId?: string,
    datatokenAddress?: string
  ) {
    const changes = { type, timestamp, consumer, payer, datatokenAddress, startOrderId }
    return orNull(`Error when updating order ${orderId}`, async () => {
      await this.orders.modify(orderId, (order) => ({
        ...order,
        ...lodash.omitBy(changes, lodash.isUndefined)
      }))
      return changes
    })
  }

  delete(orderId: string) {
    return orNull(`Error when deleting order ${orderId}`, async () =>
      (await this.orders.delete(orderId)) ? { id: orderId } : null
    )
  }
}
