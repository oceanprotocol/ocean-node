import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { hasValidDBConfiguration } from '../../utils/database.js'
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
  AbstractOrderDatabase
} from './BaseDatabase.js'
import { C2DDatabase } from './C2DDatabase.js'
import { DatabaseFactory } from './DatabaseFactory.js'
import { ElasticsearchSchema } from './ElasticSchemas.js'
import { SQLLiteConfigDatabase } from './SQLLiteConfigDatabase.js'
import { SQLLiteNonceDatabase } from './SQLLiteNonceDatabase.js'
import { TypesenseSchema } from './TypesenseSchemas.js'
import { AuthTokenDatabase } from './AuthTokenDatabase.js'

export type Schema = ElasticsearchSchema | TypesenseSchema

export class Database {
  ddo: AbstractDdoDatabase
  nonce: SQLLiteNonceDatabase
  indexer: AbstractIndexerDatabase
  logs: AbstractLogDatabase
  order: AbstractOrderDatabase
  ddoState: AbstractDdoStateDatabase
  sqliteConfig: SQLLiteConfigDatabase
  c2d: C2DDatabase
  authToken: AuthTokenDatabase

  constructor(private config: OceanNodeDBConfig) {
    return (async (): Promise<Database> => {
      try {
        // these databases use SQLite provider
        this.nonce = await DatabaseFactory.createNonceDatabase(this.config)
        this.sqliteConfig = await DatabaseFactory.createConfigDatabase()
        this.c2d = await DatabaseFactory.createC2DDatabase(this.config)
        this.authToken = await DatabaseFactory.createAuthTokenDatabase(this.config)
        // only for Typesense or Elasticsearch
        if (hasValidDBConfiguration(this.config)) {
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
          this.ddo = await DatabaseFactory.createDdoDatabase(this.config)
          this.indexer = await DatabaseFactory.createIndexerDatabase(this.config)
          this.logs = await DatabaseFactory.createLogDatabase(this.config)
          this.order = await DatabaseFactory.createOrderDatabase(this.config)
          this.ddoState = await DatabaseFactory.createDdoStateDatabase(this.config)
        } else {
          DATABASE_LOGGER.info(
            'Invalid DB URL. Only Nonce, C2D, Auth Token and Config Databases are initialized. Other databases are not available.'
          )
        }
        return this
      } catch (error) {
        DATABASE_LOGGER.error(`Database initialization failed: ${error}`)
        return null
      }
    })() as unknown as Database
  }

  // useful to know which configuration was passed to DB
  getConfig(): OceanNodeDBConfig {
    return this.config
  }
}
