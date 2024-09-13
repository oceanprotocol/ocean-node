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

export class DatabaseFactory {
  static createNonceDatabase(config: OceanNodeDBConfig): AbstractNonceDatabase {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchNonceDatabase(config)
    }
    return new TypesenseNonceDatabase(config, typesenseSchemas.nonceSchemas)
  }

  static createDdoDatabase(config: OceanNodeDBConfig): AbstractDdoDatabase {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchDdoDatabase(config, elasticSchemas.ddoSchemas)
    }
    return new TypesenseDdoDatabase(config, typesenseSchemas.ddoSchemas)
  }

  static createIndexerDatabase(config: OceanNodeDBConfig): AbstractIndexerDatabase {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchIndexerDatabase(config)
    }
    return new TypesenseIndexerDatabase(config, typesenseSchemas.indexerSchemas)
  }

  static createLogDatabase(config: OceanNodeDBConfig): AbstractLogDatabase {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchLogDatabase(config)
    }
    return new TypesenseLogDatabase(config, typesenseSchemas.logSchemas)
  }

  static createOrderDatabase(config: OceanNodeDBConfig): AbstractOrderDatabase {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchOrderDatabase(config, elasticSchemas.orderSchema)
    }
    return new TypesenseOrderDatabase(config, typesenseSchemas.orderSchema)
  }

  static createDdoStateDatabase(config: OceanNodeDBConfig): AbstractDdoStateDatabase {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchDdoStateDatabase(config)
    }
    return new TypesenseDdoStateDatabase(config, typesenseSchemas.ddoStateSchema)
  }

  static createDdoStateQuery(): IDdoStateQuery {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticSearchDdoStateQuery()
    }
    return new TypesenseDdoStateQuery()
  }

  static createMetadataQuery(): IMetadataQuery {
    if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticSearchMetadataQuery()
    }
    return new TypesenseMetadataQuery()
  }
}
