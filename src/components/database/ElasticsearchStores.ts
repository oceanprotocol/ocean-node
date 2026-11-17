import type { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { AuthTokenDatabase } from './AuthTokenDatabase.js'
import { C2DDatabase } from './C2DDatabase.js'
import type { DatabaseStores } from './DatabaseFactory.js'
import { elasticSchemas } from './ElasticSchemas.js'
import {
  ElasticsearchAccessListDatabase,
  ElasticsearchDdoDatabase,
  ElasticsearchDdoStateDatabase,
  ElasticsearchEscrowDatabase,
  ElasticsearchIndexerDatabase,
  ElasticsearchLogDatabase,
  ElasticsearchNonceDatabase,
  ElasticsearchOrderDatabase
} from './ElasticSearchDatabase.js'
import { ElasticsearchAuthToken } from './ElasticsearchAuthToken.js'
import { ElasticsearchBucketRegistry } from './ElasticsearchBucketRegistry.js'
import { ElasticsearchCompute } from './ElasticsearchCompute.js'
import { ElasticsearchConfigDatabase } from './ElasticsearchConfigDatabase.js'
import { ElasticsearchNodeMetrics } from './ElasticsearchNodeMetrics.js'

// the stores are built one after the other, so the first failure stops the rest
export async function createElasticsearchStores(
  config: OceanNodeDBConfig
): Promise<DatabaseStores> {
  return {
    nonce: await new ElasticsearchNonceDatabase(config),
    config: await ElasticsearchConfigDatabase.create(config),
    c2d: new C2DDatabase(config, await ElasticsearchCompute.create(config)),
    authToken: new AuthTokenDatabase(config, await ElasticsearchAuthToken.create(config)),
    buckets: await ElasticsearchBucketRegistry.create(config),
    nodeMetrics: await ElasticsearchNodeMetrics.create(config),
    ddo: await new ElasticsearchDdoDatabase(config, elasticSchemas.ddoSchemas),
    indexer: await new ElasticsearchIndexerDatabase(config),
    logs: await new ElasticsearchLogDatabase(config),
    order: await new ElasticsearchOrderDatabase(config, elasticSchemas.orderSchema),
    ddoState: await new ElasticsearchDdoStateDatabase(config),
    accessList: await new ElasticsearchAccessListDatabase(config),
    escrow: await new ElasticsearchEscrowDatabase(config, elasticSchemas.escrowSchema)
  }
}
