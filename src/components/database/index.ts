import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { hasValidDBConfiguration } from '../../utils/database.js'
import {
  configureCustomDBTransport,
  USE_DB_TRANSPORT
} from '../../utils/logging/Logger.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import {
  AbstractAccessListDatabase,
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractEscrowDatabase,
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
  accessList: AbstractAccessListDatabase
  escrow: AbstractEscrowDatabase
  sqliteConfig: SQLLiteConfigDatabase
  c2d: C2DDatabase
  authToken: AuthTokenDatabase
  // true only when the metadata (Typesense/Elasticsearch) databases were all initialized.
  // false in DEGRADED mode (metadata DB unreachable) and when no metadata DB is configured.
  metadataInitialized: boolean = false

  constructor(private config: OceanNodeDBConfig) {}

  // When a metadata (Typesense/Elasticsearch) database fails to initialize we either give up
  // (return null, so the caller keeps retrying while the DB comes up) or, when allowPartial is
  // set, return the already-built SQLite core (nonce/config/c2d/authToken) so the node can run
  // in DEGRADED mode with C2D / nonce / auth available but Indexer and DDO features disabled.
  private static handleMetadataInitFailure(
    db: Database,
    allowPartial: boolean
  ): Database | null {
    if (allowPartial) {
      DATABASE_LOGGER.warn(
        'Metadata database unreachable — starting in DEGRADED mode: Indexer and DDO features are disabled, C2D / nonce / auth remain available'
      )
      return db
    }
    return null
  }

  static async init(
    config: OceanNodeDBConfig,
    allowPartial: boolean = false
  ): Promise<Database | null> {
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
        return Database.handleMetadataInitFailure(db, allowPartial)
      }
      try {
        db.indexer = await DatabaseFactory.createIndexerDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`Indexer database initialization failed: ${error}`)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.logs = await DatabaseFactory.createLogDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`Logs database initialization failed: ${error}`)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.order = await DatabaseFactory.createOrderDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`Order database initialization failed: ${error}`)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.ddoState = await DatabaseFactory.createDdoStateDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`DDO State database initialization failed: ${error}`)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.accessList = await DatabaseFactory.createAccessListDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`AccessList database initialization failed: ${error}`)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.escrow = await DatabaseFactory.createEscrowDatabase(config)
      } catch (error) {
        DATABASE_LOGGER.error(`Escrow database initialization failed: ${error}`)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }
      // All metadata databases initialized successfully — this is a full (non-degraded) node.
      db.metadataInitialized = true
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
