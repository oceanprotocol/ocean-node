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
import { DatabaseFactory } from './DatabaseFactory.js'
import { ElasticsearchSchema } from './ElasticSchemas.js'
import { ConfigDatabase } from './ConfigDatabase.js'
import { AuthTokenDatabase } from './AuthTokenDatabase.js'
import { NodeMetricsProvider } from './NodeMetricsDatabase.js'
import { BucketRegistry } from './BucketRegistry.js'

export type Schema = ElasticsearchSchema

export class Database {
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

  constructor(private dbConfig: OceanNodeDBConfig) {}

  // builds one store; a failure is logged and rethrown so init() gives up
  private static async build<T>(name: string, create: () => Promise<T>): Promise<T> {
    try {
      return await create()
    } catch (error) {
      DATABASE_LOGGER.error(
        `${name} database initialization failed (will retry): ${errorSummary(error)}`
      )
      throw error
    }
  }

  // returns null when any store fails, so the caller retries while the DB comes up
  static async init(config: OceanNodeDBConfig): Promise<Database | null> {
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
    const db = new Database(config)
    const factory = DatabaseFactory
    try {
      db.nonce = await Database.build('Nonce', () => factory.createNonceDatabase(config))
      db.config = await Database.build('Config', () =>
        factory.createConfigDatabase(config)
      )
      db.c2d = await Database.build('C2D', () => factory.createC2DDatabase(config))
      db.authToken = await Database.build('Auth', () =>
        factory.createAuthTokenDatabase(config)
      )
      db.buckets = await Database.build('Buckets', () =>
        factory.createBucketRegistry(config)
      )
      db.nodeMetrics = await Database.build('Node metrics', () =>
        factory.createNodeMetricsDatabase(config)
      )
      db.ddo = await Database.build('DDO', () => factory.createDdoDatabase(config))
      db.indexer = await Database.build('Indexer', () =>
        factory.createIndexerDatabase(config)
      )
      db.logs = await Database.build('Logs', () => factory.createLogDatabase(config))
      // attach the DB log transport only once the log database exists; a later call (retry)
      // rebinds it to the new instance
      if (USE_DB_TRANSPORT()) {
        configureCustomDBTransport(db, DATABASE_LOGGER)
      }
      db.order = await Database.build('Order', () => factory.createOrderDatabase(config))
      db.ddoState = await Database.build('DDO State', () =>
        factory.createDdoStateDatabase(config)
      )
      db.accessList = await Database.build('AccessList', () =>
        factory.createAccessListDatabase(config)
      )
      db.escrow = await Database.build('Escrow', () =>
        factory.createEscrowDatabase(config)
      )
    } catch {
      return null
    }
    DATABASE_LOGGER.info(
      'Database ready: Elasticsearch (nonce, config, c2d, auth, buckets, metrics, ddo, indexer, logs, order, ddoState, accessList, escrow)'
    )
    return db
  }

  // useful to know which configuration was passed to DB
  getConfig(): OceanNodeDBConfig {
    return this.dbConfig
  }
}
