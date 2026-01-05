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

  constructor(private config: OceanNodeDBConfig) {}

  static async init(config: OceanNodeDBConfig): Promise<Database | null> {
    const db = new Database(config)
    try {
      db.nonce = await DatabaseFactory.createNonceDatabase(config)
    } catch (error) {
      DATABASE_LOGGER.error(`Nonce database initialization failed: ${error}`)
      return null
    }
    try {
      db.sqliteConfig = await DatabaseFactory.createConfigDatabase()
    } catch (error) {
      DATABASE_LOGGER.error(`Config database initialization failed: ${error}`)
      return null
    }
    try {
      db.c2d = await DatabaseFactory.createC2DDatabase(config)
    } catch (error) {
      DATABASE_LOGGER.error(`C2D database initialization failed: ${error}`)
      return null
    }
    try {
      db.authToken = await DatabaseFactory.createAuthTokenDatabase(config)
    } catch (error) {
      DATABASE_LOGGER.error(`Auth database initialization failed: ${error}`)
      return null
    }

    if (hasValidDBConfiguration(config)) {
      if (USE_DB_TRANSPORT()) {
        configureCustomDBTransport(db, DATABASE_LOGGER)
      } else {
        DATABASE_LOGGER.warn('LOG_DB is false. Logs will NOT be saved to DB!')
      }
      try {
        db.ddo = await DatabaseFactory.createDdoDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`DDO database initialization failed: ${error}`)
        return null
      }
      try {
        db.indexer = await DatabaseFactory.createIndexerDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`Indexer database initialization failed: ${error}`)
        return null
      }

      try {
        db.logs = await DatabaseFactory.createLogDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`Logs database initialization failed: ${error}`)
        return null
      }

      try {
        db.order = await DatabaseFactory.createOrderDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`Order database initialization failed: ${error}`)
        return null
      }

      try {
        db.ddoState = await DatabaseFactory.createDdoStateDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`DDO State database initialization failed: ${error}`)
        return null
      }
    } else {
      DATABASE_LOGGER.info(
        'Invalid DB URL. Only Nonce, C2D, Auth Token and Config Databases are initialized.'
      )
    }

    return db
  }

  // useful to know which configuration was passed to DB
  getConfig(): OceanNodeDBConfig {
    return this.config
  }
}
