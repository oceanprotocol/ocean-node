import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import {
  configureCustomDBTransport,
  getLoggingConfig,
  isFileLoggingActive,
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
  AbstractNonceDatabase,
  AbstractOrderDatabase
} from './BaseDatabase.js'
import { C2DDatabase } from './C2DDatabase.js'
import { DatabaseFactory, DatabaseStores } from './DatabaseFactory.js'
import { ConfigDatabase } from './ConfigDatabase.js'
import { AuthTokenDatabase } from './AuthTokenDatabase.js'
import { NodeMetricsProvider } from './NodeMetricsDatabase.js'
import { BucketRegistry } from './BucketRegistry.js'

export type { DdoSchema } from './BaseDatabase.js'

function logWhereLogsGo(): void {
  if (USE_DB_TRANSPORT()) {
    return
  }
  if (isFileLoggingActive()) {
    DATABASE_LOGGER.info(
      `LOG_DB disabled; logs are written to disk (${getLoggingConfig().dir})`
    )
  } else {
    DATABASE_LOGGER.warn('LOG_DB and file logging are disabled: logs are not persisted')
  }
}

export class Database implements DatabaseStores {
  ddo: AbstractDdoDatabase
  nonce: AbstractNonceDatabase
  indexer: AbstractIndexerDatabase
  logs: AbstractLogDatabase
  order: AbstractOrderDatabase
  ddoState: AbstractDdoStateDatabase
  accessList: AbstractAccessListDatabase
  escrow: AbstractEscrowDatabase
  config: ConfigDatabase
  c2d: C2DDatabase
  authToken: AuthTokenDatabase
  buckets: BucketRegistry
  nodeMetrics: NodeMetricsProvider

  private constructor(
    private dbConfig: OceanNodeDBConfig,
    stores: DatabaseStores
  ) {
    Object.assign(this, stores)
  }

  // returns null when a store fails, so the caller retries while the database comes up
  static async init(config: OceanNodeDBConfig): Promise<Database | null> {
    logWhereLogsGo()
    try {
      const db = new Database(config, await DatabaseFactory.createStores(config))
      // a later call (retry) binds the log transport to the new log store
      if (USE_DB_TRANSPORT()) {
        configureCustomDBTransport(db, DATABASE_LOGGER)
      }
      DATABASE_LOGGER.info(`Database ready: ${config.dbType}`)
      return db
    } catch (error) {
      DATABASE_LOGGER.error(
        `Database initialization failed (will retry): ${errorSummary(error)}`
      )
      return null
    }
  }

  // useful to know which configuration was passed to DB
  getConfig(): OceanNodeDBConfig {
    return this.dbConfig
  }
}
