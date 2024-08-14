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
  static createNonceDatabase(
    config: OceanNodeDBConfig,
    schema: TypesenseSchema
  ): AbstractNonceDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseNonceDatabase(config, schema)
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

  static createIndexerDatabase(
    config: OceanNodeDBConfig,
    schema: TypesenseSchema
  ): AbstractIndexerDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseIndexerDatabase(config, schema)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchIndexerDatabase(config)
    }
    throw new Error('Unsupported database type')
  }

  static createLogDatabase(
    config: OceanNodeDBConfig,
    schema: TypesenseSchema
  ): AbstractLogDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseLogDatabase(config, schema)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchLogDatabase(config)
    }
    throw new Error('Unsupported database type')
  }

  static createOrderDatabase(
    config: OceanNodeDBConfig,
    schema: TypesenseSchema
  ): AbstractOrderDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseOrderDatabase(config, schema)
    }
    // else if (process.env.DB_TYPE === 'elasticsearch') {
    //   return new ElasticOrderDatabase(config, schema)
    // }
    throw new Error('Unsupported database type')
  }

  static createDdoStateDatabase(
    config: OceanNodeDBConfig,
    schema: TypesenseSchema
  ): AbstractDdoStateDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseDdoStateDatabase(config, schema)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchDdoStateDatabase(config)
    }
    throw new Error('Unsupported database type')
  }
}
