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
import { IMetadataQuery } from '../../@types/DDO/IMetadataQuery.js'
import { TypesenseMetadataQuery } from './TypesenseMetadataQuery.js'
import { ElasticSearchMetadataQuery } from './ElasticSearchMetadataQuery.js'

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
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticsearchOrderDatabase(config, elasticSchemas.orderSchema)
    }
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

  static createDdoStateQuery(): IDdoStateQuery {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseDdoStateQuery()
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticSearchDdoStateQuery()
    }
    throw new Error('Unsupported database type')
  }

  static createMetadataQuery(): IMetadataQuery {
    if (process.env.DB_TYPE === 'typesense') {
      return new TypesenseMetadataQuery()
    } else if (process.env.DB_TYPE === 'elasticsearch') {
      return new ElasticSearchMetadataQuery()
    }
    throw new Error('Unsupported database type')
  }
}
