import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import {
  configureCustomDBTransport,
  USE_DB_TRANSPORT
} from '../../utils/logging/Logger.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import {
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractNonceDatabase,
  AbstractOrderDatabase
} from './BaseDatabase.js'
import { DatabaseFactory } from './DatabaseFactory.js'
import { ElasticsearchSchema } from './ElasticSchemas.js'
import { TypesenseSchema } from './TypesenseSchemas.js'

export type Schema = ElasticsearchSchema | TypesenseSchema

export class Database {
  ddo: AbstractDdoDatabase
  nonce: AbstractNonceDatabase
  indexer: AbstractIndexerDatabase
  logs: AbstractLogDatabase
  order: AbstractOrderDatabase
  ddoState: AbstractDdoStateDatabase

  constructor(private config: OceanNodeDBConfig) {
    // add this DB transport too
    // once we create a DB instance, the logger will be using this transport as well
    // we cannot have this the other way around because of the dependencies cycle
    if (USE_DB_TRANSPORT()) {
      configureCustomDBTransport(this, DATABASE_LOGGER)
    } else {
      DATABASE_LOGGER.warn(
        'Property "LOG_DB" is set to "false". This means logs will NOT be saved to database!'
      )
    }
    return (async (): Promise<Database> => {
      this.ddo = await DatabaseFactory.createDdoDatabase(this.config)
      this.nonce = await DatabaseFactory.createNonceDatabase(
        this.config,
        schemas.nonceSchemas
      )
      this.indexer = await DatabaseFactory.createIndexerDatabase(
        this.config,
        schemas.indexerSchemas
      )
      this.logs = await DatabaseFactory.createLogDatabase(this.config, schemas.logSchemas)
      this.order = await DatabaseFactory.createOrderDatabase(
        this.config,
        schemas.orderSchema
      )
      this.ddoState = await DatabaseFactory.createDdoStateDatabase(
        this.config,
        schemas.ddoStateSchema
      )
      return this
    })() as unknown as Database
  }
}
