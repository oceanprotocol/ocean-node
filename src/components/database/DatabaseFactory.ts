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
import { Schema } from './schemas'
import {
  TypesenseDdoDatabase,
  TypesenseDdoStateDatabase,
  TypesenseIndexerDatabase,
  TypesenseLogDatabase,
  TypesenseNonceDatabase,
  TypesenseOrderDatabase
} from './TypenseDatabase'

export class DatabaseFactory {
  static createNonceDatabase(
    config: OceanNodeDBConfig,
    schema: Schema
  ): AbstractNonceDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseNonceDatabase(config, schema)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchNonceDatabase(config)
    }
    throw new Error('Unsupported database type')
  }

  static createDdoDatabase(
    config: OceanNodeDBConfig,
    schemas: Schema[]
  ): AbstractDdoDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseDdoDatabase(config, schemas)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchDdoDatabase(config, schemas)
    }
    throw new Error('Unsupported database type')
  }

  static createIndexerDatabase(
    config: OceanNodeDBConfig,
    schema: Schema
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
    schema: Schema
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
    schema: Schema
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
    schema: Schema
  ): AbstractDdoStateDatabase {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseDdoStateDatabase(config, schema)
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchDdoStateDatabase(config)
    }
    throw new Error('Unsupported database type')
  }
}