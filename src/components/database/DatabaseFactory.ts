import type { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import type { AuthTokenDatabase } from './AuthTokenDatabase.js'
import type {
  AbstractAccessListDatabase,
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractEscrowDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractNonceDatabase,
  AbstractOrderDatabase
} from './BaseDatabase.js'
import type { BucketRegistry } from './BucketRegistry.js'
import type { C2DDatabase } from './C2DDatabase.js'
import type { ConfigDatabase } from './ConfigDatabase.js'
import { createElasticsearchStores } from './ElasticsearchStores.js'
import type { NodeMetricsProvider } from './NodeMetricsDatabase.js'
import { isReachableConnection } from '../../utils/database.js'
import { createPostgresStores } from './sql/PostgresStores.js'
import { createSqliteStores, sqliteStateFiles } from './sql/SqliteStores.js'

// all the stores of a node; each backend builds the full set
export interface DatabaseStores {
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
}

// the only place that knows which backends exist
export class DatabaseFactory {
  static createStores(config: OceanNodeDBConfig): Promise<DatabaseStores> {
    switch (config.dbType) {
      case 'sqlite':
        return createSqliteStores(config)
      case 'postgresql':
        return createPostgresStores(config)
      case 'elasticsearch':
        return createElasticsearchStores(config)
    }
  }

  // The node state in the SQLite files of this folder does not move to a database server.
  // The node must not start on empty state without a decision of the operator: with
  // empty nonces a signed request can be sent again, and paid jobs are never claimed.
  static refuseLeftoverSqliteState(config: OceanNodeDBConfig, dir?: string): void {
    const files = config.dbType === 'sqlite' ? [] : sqliteStateFiles(dir)
    if (files.length > 0) {
      throw new Error(
        `Node state is in SQLite files (${files.join(', ')}), from an older release or ` +
          `from a node that used SQLite. It does not move to ${config.dbType}. ` +
          `To keep it, set DB_TYPE=sqlite. To start with empty state on ${config.dbType}, ` +
          `remove these files.`
      )
    }
  }

  // a cheap check before createStores; a backend with no such check reports its failed
  // connection from createStores
  static isReachable(config: OceanNodeDBConfig): Promise<boolean> {
    return config.dbType === 'elasticsearch'
      ? isReachableConnection(config.url)
      : Promise.resolve(true)
  }
}
