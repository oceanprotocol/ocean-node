import { OceanNodeDBConfig } from '../../@types'
import {
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractNonceDatabase,
  AbstractOrderDatabase
} from './BaseDatabase.js'
import {
  ElasticsearchDdoDatabase,
  ElasticsearchDdoStateDatabase,
  ElasticsearchIndexerDatabase,
  ElasticsearchLogDatabase,
  ElasticsearchNonceDatabase,
  ElasticsearchOrderDatabase
} from './ElasticSearchDatabase.js'
import { typesenseSchemas } from './TypesenseSchemas.js'
import {
  TypesenseDdoDatabase,
  TypesenseDdoStateDatabase,
  TypesenseIndexerDatabase,
  TypesenseLogDatabase,
  TypesenseNonceDatabase,
  TypesenseOrderDatabase
} from './TypenseDatabase.js'
import { elasticSchemas } from './ElasticSchemas.js'
import { IDdoStateQuery } from '../../@types/DDO/IDdoStateQuery.js'
import { TypesenseDdoStateQuery } from './TypesenseDdoStateQuery.js'
import { ElasticSearchDdoStateQuery } from './ElasticSearchDdoStateQuery.js'
import { TypesenseMetadataQuery } from './TypesenseMetadataQuery.js'
import { IMetadataQuery } from '../../@types/DDO/IMetadataQuery.js'
import { ElasticSearchMetadataQuery } from './ElasticSearchMetadataQuery.js'
import { DB_TYPES } from '../../utils/index.js'
import { C2DDatabase } from './C2DDatabase.js'

export class DatabaseFactory {
  private static databaseMap = {
    elasticsearch: {
      nonce: (config: OceanNodeDBConfig) => new ElasticsearchNonceDatabase(config),
      ddo: (config: OceanNodeDBConfig) =>
        new ElasticsearchDdoDatabase(config, elasticSchemas.ddoSchemas),
      indexer: (config: OceanNodeDBConfig) => new ElasticsearchIndexerDatabase(config),
      log: (config: OceanNodeDBConfig) => new ElasticsearchLogDatabase(config),
      order: (config: OceanNodeDBConfig) =>
        new ElasticsearchOrderDatabase(config, elasticSchemas.orderSchema),
      ddoState: (config: OceanNodeDBConfig) => new ElasticsearchDdoStateDatabase(config),
      ddoStateQuery: () => new ElasticSearchDdoStateQuery(),
      metadataQuery: () => new ElasticSearchMetadataQuery()
    },
    typesense: {
      nonce: (config: OceanNodeDBConfig) =>
        new TypesenseNonceDatabase(config, typesenseSchemas.nonceSchemas),
      ddo: (config: OceanNodeDBConfig) =>
        new TypesenseDdoDatabase(config, typesenseSchemas.ddoSchemas),
      indexer: (config: OceanNodeDBConfig) =>
        new TypesenseIndexerDatabase(config, typesenseSchemas.indexerSchemas),
      log: (config: OceanNodeDBConfig) =>
        new TypesenseLogDatabase(config, typesenseSchemas.logSchemas),
      order: (config: OceanNodeDBConfig) =>
        new TypesenseOrderDatabase(config, typesenseSchemas.orderSchema),
      ddoState: (config: OceanNodeDBConfig) =>
        new TypesenseDdoStateDatabase(config, typesenseSchemas.ddoStateSchema),
      ddoStateQuery: () => new TypesenseDdoStateQuery(),
      metadataQuery: () => new TypesenseMetadataQuery()
    }
  }

  private static getDatabaseType(config: OceanNodeDBConfig): any {
    return config.dbType === DB_TYPES.ELASTIC_SEARCH
      ? DB_TYPES.ELASTIC_SEARCH
      : DB_TYPES.TYPESENSE
  }

  private static createDatabase<T>(
    databaseType: keyof (typeof DatabaseFactory.databaseMap)['elasticsearch'],
    config: OceanNodeDBConfig
  ): T {
    const dbTypeKey: keyof typeof this.databaseMap = this.getDatabaseType(config)
    const databaseCreator = this.databaseMap[dbTypeKey][databaseType]
    return databaseCreator(config) as T
  }

  static createNonceDatabase(config: OceanNodeDBConfig): Promise<AbstractNonceDatabase> {
    return this.createDatabase('nonce', config)
  }

  static createDdoDatabase(config: OceanNodeDBConfig): Promise<AbstractDdoDatabase> {
    return this.createDatabase('ddo', config)
  }

  static createC2DDatabase(config: OceanNodeDBConfig): C2DDatabase {
    return new C2DDatabase(config, typesenseSchemas.c2dSchemas)
  }

  static createIndexerDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractIndexerDatabase> {
    return this.createDatabase('indexer', config)
  }

  static createLogDatabase(config: OceanNodeDBConfig): Promise<AbstractLogDatabase> {
    return this.createDatabase('log', config)
  }

  static createOrderDatabase(config: OceanNodeDBConfig): Promise<AbstractOrderDatabase> {
    return this.createDatabase('order', config)
  }

  static createDdoStateDatabase(
    config: OceanNodeDBConfig
  ): Promise<AbstractDdoStateDatabase> {
    return this.createDatabase('ddoState', config)
  }

  static createDdoStateQuery(config: OceanNodeDBConfig): Promise<IDdoStateQuery> {
    return this.createDatabase('ddoStateQuery', config)
  }

  static createMetadataQuery(config: OceanNodeDBConfig): Promise<IMetadataQuery> {
    return this.createDatabase('metadataQuery', config)
  }
}
