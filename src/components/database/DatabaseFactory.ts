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
import { createPostgresStores } from './sql/PostgresStores.js'
import { createSqliteStores } from './sql/SqliteStores.js'

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
      default:
        throw new Error(`Unknown database type: ${config.dbType}`)
    }
  }

  // a cheap check before createStores; a backend with no such check reports its failed
  // connection from createStores
  static async isReachable(config: OceanNodeDBConfig): Promise<boolean> {
    if (config.dbType !== 'elasticsearch') return true
    try {
      await fetch(config.url)
      return true
    } catch {
      return false
    }
  }
}
