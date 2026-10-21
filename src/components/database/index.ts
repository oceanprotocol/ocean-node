import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { hasValidDBConfiguration } from '../../utils/database.js'
import {
  configureCustomDBTransport,
  getLoggingConfig,
  isFileLoggingActive,
  LOG_LEVELS_STR,
  USE_DB_TRANSPORT
} from '../../utils/logging/Logger.js'
import { errorSummary } from '../../utils/logging/redact.js'
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
import { NodeMetricsDatabase } from './sqliteNodeMetrics.js'

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
  nodeMetrics: NodeMetricsDatabase
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
      // src/index.ts reports DEGRADED mode to the operator
      DATABASE_LOGGER.debug(
        'Metadata database unreachable — starting in DEGRADED mode: Indexer and DDO features are disabled, C2D / nonce / auth remain available'
      )
      return db
    }
    return null
  }

  // a retry follows unless this is the final (allowPartial) attempt
  private static logMetadataInitFailure(
    name: string,
    error: unknown,
    allowPartial: boolean
  ): void {
    DATABASE_LOGGER.log(
      allowPartial ? LOG_LEVELS_STR.LEVEL_ERROR : LOG_LEVELS_STR.LEVEL_WARN,
      `${name} database initialization failed: ${errorSummary(error)}`,
      true
    )
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
    try {
      db.nodeMetrics = await DatabaseFactory.createNodeMetricsDatabase()
    } catch (error) {
      // Node metrics history is a best-effort, non-critical feature: a failure here must not
      // stop the node from starting. Leave db.nodeMetrics undefined; the cron jobs and history
      // handler guard on its presence.
      DATABASE_LOGGER.warn(`Node metrics database initialization failed: ${error}`)
    }

    if (hasValidDBConfiguration(config)) {
      if (!USE_DB_TRANSPORT()) {
        if (isFileLoggingActive()) {
          DATABASE_LOGGER.info(
            `LOG_DB disabled; logs are written to disk (${getLoggingConfig().dir})`
          )
        } else {
          DATABASE_LOGGER.warn(
            'LOG_DB and file logging are disabled: logs are not persisted'
          )
        }
      }
      try {
        db.ddo = await DatabaseFactory.createDdoDatabase(config)
      } catch (error) {
        Database.logMetadataInitFailure('DDO', error, allowPartial)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }
      try {
        db.indexer = await DatabaseFactory.createIndexerDatabase(config)
      } catch (error) {
        Database.logMetadataInitFailure('Indexer', error, allowPartial)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.logs = await DatabaseFactory.createLogDatabase(config)
      } catch (error) {
        Database.logMetadataInitFailure('Logs', error, allowPartial)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }
      // attach the DB log transport only once the log database exists; a later call (retry)
      // rebinds it to the new instance
      if (USE_DB_TRANSPORT()) {
        configureCustomDBTransport(db, DATABASE_LOGGER)
      }

      try {
        db.order = await DatabaseFactory.createOrderDatabase(config)
      } catch (error) {
        Database.logMetadataInitFailure('Order', error, allowPartial)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.ddoState = await DatabaseFactory.createDdoStateDatabase(config)
      } catch (error) {
        Database.logMetadataInitFailure('DDO State', error, allowPartial)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.accessList = await DatabaseFactory.createAccessListDatabase(config)
      } catch (error) {
        Database.logMetadataInitFailure('AccessList', error, allowPartial)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }

      try {
        db.escrow = await DatabaseFactory.createEscrowDatabase(config)
      } catch (error) {
        Database.logMetadataInitFailure('Escrow', error, allowPartial)
        return Database.handleMetadataInitFailure(db, allowPartial)
      }
      // All metadata databases initialized successfully — this is a full (non-degraded) node.
      db.metadataInitialized = true
    } else {
      // src/index.ts reports the missing / invalid DB_URL to the operator
      DATABASE_LOGGER.debug(
        'Invalid DB URL. Only Nonce, C2D, Auth Token and Config Databases are initialized.'
      )
    }

    DATABASE_LOGGER.info(
      `Database ready: SQLite (nonce, config, c2d, auth${
        db.nodeMetrics ? ', metrics' : ''
      })${db.metadataInitialized ? ` + ${config.dbType} metadata DB` : ', no metadata DB'}`
    )
    return db
  }

  // useful to know which configuration was passed to DB
  getConfig(): OceanNodeDBConfig {
    return this.config
  }
}
