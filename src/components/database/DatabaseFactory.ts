import { OceanNodeDBConfig } from '../../@types'
import {
  AbstractDdoDatabase,
  AbstractDdoStateDatabase,
  AbstractIndexerDatabase,
  AbstractLogDatabase,
  AbstractNonceDatabase,
  AbstractOrderDatabase
} from './BaseDatabase'
import {
  ElasticsearchDdoDatabase,
  ElasticsearchDdoStateDatabase,
  ElasticsearchIndexerDatabase,
  ElasticsearchLogDatabase,
  ElasticsearchNonceDatabase
} from './ElasticSearchDatabase'
import { TypesenseSchema, typesenseSchemas } from './TypesenseSchemas'
import {
  TypesenseDdoDatabase,
  TypesenseDdoStateDatabase,
  TypesenseIndexerDatabase,
  TypesenseLogDatabase,
  TypesenseNonceDatabase,
  TypesenseOrderDatabase
} from './TypenseDatabase'
import { elasticSchemas } from './ElasticSchemas'

export class DatabaseFactory {
  static createNonceDatabase(config: OceanNodeDBConfig): AbstractNonceDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseNonceDatabase(config, typesenseSchemas.nonceSchemas)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchNonceDatabase(config)
    }
    throw new Error('Unsupported database type')
  }

  static createDdoDatabase(config: OceanNodeDBConfig): AbstractDdoDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseDdoDatabase(config, typesenseSchemas.ddoSchemas)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchDdoDatabase(config, elasticSchemas.ddoSchemas)
    }
    throw new Error('Unsupported database type')
  }

  static createIndexerDatabase(config: OceanNodeDBConfig): AbstractIndexerDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseIndexerDatabase(config, typesenseSchemas.indexerSchemas)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchIndexerDatabase(config)
    }
    throw new Error('Unsupported database type')
  }

  static createLogDatabase(config: OceanNodeDBConfig): AbstractLogDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseLogDatabase(config, typesenseSchemas.logSchemas)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchLogDatabase(config)
    }
    throw new Error('Unsupported database type')
  }

  static createOrderDatabase(config: OceanNodeDBConfig): AbstractOrderDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseOrderDatabase(config, typesenseSchemas.orderSchema)
    }
    // else if (process.env.DB_TYPE === 'elasticsearch') {
    //   return new ElasticOrderDatabase(config, typesenseSchemas.ddoSchemas)
    // }
    throw new Error('Unsupported database type')
  }

  static createDdoStateDatabase(config: OceanNodeDBConfig): AbstractDdoStateDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseDdoStateDatabase(config, typesenseSchemas.ddoStateSchema)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchDdoStateDatabase(config)
    }
    throw new Error('Unsupported database type')
  }
}
