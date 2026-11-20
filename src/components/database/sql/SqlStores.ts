import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import { AuthTokenDatabase } from '../AuthTokenDatabase.js'
import { C2DDatabase } from '../C2DDatabase.js'
import type { DatabaseStores } from '../DatabaseFactory.js'
import type { SqlClient } from './SqlClient.js'
import { SqlAuthToken } from './SqlAuthToken.js'
import { SqlBucketRegistry } from './SqlBucketRegistry.js'
import { SqlCompute } from './SqlCompute.js'
import { SqlConfigDatabase } from './SqlConfig.js'
import { SqlNodeMetrics } from './SqlNodeMetrics.js'
import { SqlNonceDatabase } from './SqlNonce.js'
import { SqlAccessListDatabase } from './SqlAccessList.js'
import { SqlDdoDatabase } from './SqlDdo.js'
import { SqlDdoStateDatabase } from './SqlDdoState.js'
import { SqlEscrowDatabase } from './SqlEscrow.js'
import { SqlIndexerDatabase } from './SqlIndexer.js'
import { SqlLogDatabase } from './SqlLog.js'
import { SqlOrderDatabase } from './SqlOrder.js'

// The stores are in groups. PostgreSQL has one database for all groups; SQLite has one
// file for each group.
export type SqlStateStores = Pick<
  DatabaseStores,
  'nonce' | 'config' | 'c2d' | 'authToken' | 'buckets' | 'nodeMetrics'
>
export type SqlIndexStores = Omit<DatabaseStores, keyof SqlStateStores>

export type SqlStoreGroup = keyof SqlStateStores | 'index'
export type ClientFor = (group: SqlStoreGroup) => SqlClient

// creates the tables of a store and gives the store
async function ready<T extends { init(): Promise<void> }>(store: T): Promise<T> {
  await store.init()
  return store
}

// the stores of the node state: jobs, services, nonces, tokens, settings, buckets, metrics
export async function buildSqlStateStores(
  config: OceanNodeDBConfig,
  clientFor: ClientFor
): Promise<SqlStateStores> {
  return {
    nonce: await ready(new SqlNonceDatabase(config, clientFor('nonce'))),
    config: await ready(new SqlConfigDatabase(clientFor('config'))),
    c2d: new C2DDatabase(config, await ready(new SqlCompute(clientFor('c2d')))),
    authToken: new AuthTokenDatabase(
      config,
      await ready(new SqlAuthToken(clientFor('authToken')))
    ),
    buckets: await ready(new SqlBucketRegistry(clientFor('buckets'))),
    nodeMetrics: await ready(new SqlNodeMetrics(clientFor('nodeMetrics')))
  }
}

// the stores that the indexer fills from the chains, and the logs
export async function buildSqlIndexStores(
  config: OceanNodeDBConfig,
  db: SqlClient
): Promise<SqlIndexStores> {
  return {
    ddo: await ready(new SqlDdoDatabase(config, db)),
    indexer: await ready(new SqlIndexerDatabase(config, db)),
    logs: await ready(new SqlLogDatabase(config, db)),
    order: await ready(new SqlOrderDatabase(config, db)),
    ddoState: await ready(new SqlDdoStateDatabase(config, db)),
    accessList: await ready(new SqlAccessListDatabase(config, db)),
    escrow: await ready(new SqlEscrowDatabase(config, db))
  }
}

export async function buildSqlStores(
  config: OceanNodeDBConfig,
  clientFor: ClientFor
): Promise<DatabaseStores> {
  return {
    ...(await buildSqlStateStores(config, clientFor)),
    ...(await buildSqlIndexStores(config, clientFor('index')))
  }
}
