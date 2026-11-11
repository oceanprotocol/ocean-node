import { OceanNodeDBConfig } from '../../@types'
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
import { elasticSchemas } from './ElasticSchemas.js'
import { IDdoStateQuery } from '../../@types/DDO/IDdoStateQuery.js'
import { ElasticSearchDdoStateQuery } from './ElasticSearchDdoStateQuery.js'
import { IMetadataQuery } from '../../@types/DDO/IMetadataQuery.js'
import { ElasticSearchMetadataQuery } from './ElasticSearchMetadataQuery.js'
import { C2DDatabase } from './C2DDatabase.js'
import { ConfigDatabase } from './ConfigDatabase.js'
import { ElasticsearchConfigDatabase } from './ElasticsearchConfigDatabase.js'
import { AuthTokenDatabase } from './AuthTokenDatabase.js'
import { NodeMetricsProvider } from './NodeMetricsDatabase.js'
import { ElasticsearchNodeMetrics } from './ElasticsearchNodeMetrics.js'
import { BucketRegistry } from './BucketRegistry.js'
import { ElasticsearchBucketRegistry } from './ElasticsearchBucketRegistry.js'

export class DatabaseFactory {
  static async createNonceDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractNonceDatabase> {
    return await new ElasticsearchNonceDatabase(config)
  }

  static async createDdoDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractDdoDatabase> {
    return await new ElasticsearchDdoDatabase(config, elasticSchemas.ddoSchemas)
  }

  static async createC2DDatabase(config: OceanNodeDBConfig): Promise<C2DDatabase> {
    return await new C2DDatabase(config)
  }

  static async createAuthTokenDatabase(
    config: OceanNodeDBConfig
  ): Promise<AuthTokenDatabase> {
    return await AuthTokenDatabase.create(config)
  }

  static async createIndexerDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractIndexerDatabase> {
    return await new ElasticsearchIndexerDatabase(config)
  }

  static async createLogDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractLogDatabase> {
    return await new ElasticsearchLogDatabase(config)
  }

  static async createOrderDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractOrderDatabase> {
    return await new ElasticsearchOrderDatabase(config, elasticSchemas.orderSchema)
  }

  static async createDdoStateDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractDdoStateDatabase> {
    return await new ElasticsearchDdoStateDatabase(config)
  }

  // eslint-disable-next-line require-await
  static async createDdoStateQuery(config: OceanNodeDBConfig): Promise<IDdoStateQuery> {
    return new ElasticSearchDdoStateQuery()
  }

  // eslint-disable-next-line require-await
  static async createMetadataQuery(config: OceanNodeDBConfig): Promise<IMetadataQuery> {
    return new ElasticSearchMetadataQuery()
  }

  static async createConfigDatabase(config: OceanNodeDBConfig): Promise<ConfigDatabase> {
    return await ElasticsearchConfigDatabase.create(config)
  }

  static async createBucketRegistry(config: OceanNodeDBConfig): Promise<BucketRegistry> {
    return await ElasticsearchBucketRegistry.create(config)
  }

  static async createNodeMetricsDatabase(
    config: OceanNodeDBConfig
  ): Promise<NodeMetricsProvider> {
    return await ElasticsearchNodeMetrics.create(config)
  }

  static async createAccessListDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractAccessListDatabase> {
    return await new ElasticsearchAccessListDatabase(config)
  }

  static async createEscrowDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractEscrowDatabase> {
    return await new ElasticsearchEscrowDatabase(config, elasticSchemas.escrowSchema)
  }
}
