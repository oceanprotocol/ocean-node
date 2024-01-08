import { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { convertTypesenseConfig, Typesense, TypesenseError } from './typesense.js'
import { Schema, schemas } from './schemas.js'
import { TypesenseSearchParams } from '../../@types/index.js'
import {
  CustomNodeLogger,
  defaultConsoleTransport,
  getCustomLoggerForModule,
  LOG_LEVELS_STR,
  LOGGER_MODULE_NAMES,
  newCustomDBTransport
} from '../../utils/logging/Logger.js'
import { DatabaseError } from './error.js'

export const DATABASE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.DATABASE,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

export class OrderDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<OrderDatabase> => {
      this.provider = new Typesense(convertTypesenseConfig(this.config.url))
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.schema)
        }
      }
      return this
    })() as unknown as OrderDatabase
  }

  async search(query: Record<string, any>) {
    try {
      const results = []
      const result = await this.provider
        .collections(this.schema.name)
        .documents()
        .search(query as TypesenseSearchParams)
      results.push(result)
      return results
    } catch (error) {
      return null
    }
  }

  async create(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    startOrderId?: string
  ) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id: orderId, type, timestamp, consumer, payer, startOrderId })
    } catch (error) {
      return null
    }
  }

  async retrieve(orderId: string) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .retrieve(orderId)
    } catch (error) {
      return null
    }
  }

  async update(
    orderId: string,
    type: string,
    timestamp: number,
    consumer: string,
    payer: string,
    startOrderId?: string
  ) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(orderId, { type, timestamp, consumer, payer, startOrderId })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schema.name)
          .documents()
          .create({ id: orderId, type, timestamp, consumer, payer, startOrderId })
      }
      return null
    }
  }

  async delete(orderId: string) {
    try {
      return await this.provider.collections(this.schema.name).documents().delete(orderId)
    } catch (error) {
      return null
    }
  }
}

export class DdoDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schemas: Schema[]
  ) {
    return (async (): Promise<DdoDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      for (const ddoSchema of this.schemas) {
        try {
          await this.provider.collections(ddoSchema.name).retrieve()
        } catch (error) {
          if (error instanceof TypesenseError && error.httpStatus === 404) {
            await this.provider.collections().create(ddoSchema)
          }
        }
      }
      return this
    })() as unknown as DdoDatabase
  }

  async search(query: Record<string, any>) {
    try {
      const results = []
      for (const schema of this.schemas) {
        const result = await this.provider
          .collections(schema.name)
          .documents()
          .search(query as TypesenseSearchParams)
        results.push(result)
      }
      return results
    } catch (error) {
      return null
    }
  }

  async create(ddo: Record<string, any>) {
    try {
      return await this.provider
        .collections(this.schemas[0].name)
        .documents()
        .create({ ...ddo })
    } catch (error) {
      return null
    }
  }

  async retrieve(id: string) {
    try {
      return await this.provider
        .collections(this.schemas[0].name)
        .documents()
        .retrieve(id)
    } catch (error) {
      return null
    }
  }

  async update(ddo: Record<string, any>) {
    try {
      return await this.provider
        .collections(this.schemas[0].name)
        .documents()
        .update(ddo.id, ddo)
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schemas[0].name)
          .documents()
          .create({ ...ddo })
      }
      return null
    }
  }

  async delete(did: string) {
    try {
      return await this.provider.collections(this.schemas[0].name).documents().delete(did)
    } catch (error) {
      return null
    }
  }
}

export class NonceDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<NonceDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.schema)
        }
      }
      return this
    })() as unknown as NonceDatabase
  }

  async create(address: string, nonce: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id: address, nonce })
    } catch (error) {
      const errorMsg =
        `Error when creating new nonce entry ${nonce} for address ${address}: ` +
        error.message
      DATABASE_LOGGER.logMessage(errorMsg, true)
      let status: number
      if (error instanceof TypesenseError) {
        status = error.httpStatus
      }
      return status !== 0
        ? new DatabaseError(errorMsg, status)
        : new DatabaseError(errorMsg)
    }
  }

  async retrieve(address: string) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .retrieve(address)
    } catch (error) {
      const errorMsg =
        `Error when retrieving nonce entry for address ${address}: ` + error.message
      DATABASE_LOGGER.logMessage(errorMsg, true)
      let status: number
      if (error instanceof TypesenseError) {
        status = error.httpStatus
      }
      return status !== 0
        ? new DatabaseError(errorMsg, status)
        : new DatabaseError(errorMsg)
    }
  }

  async update(address: string, nonce: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(address, { nonce })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schema.name)
          .documents()
          .create({ id: address, nonce })
      }
      const errorMsg =
        `Error when updating nonce entry ${nonce} for address ${address}: ` +
        error.message
      DATABASE_LOGGER.logMessage(errorMsg, true)
      let status: number
      if (error instanceof TypesenseError) {
        status = error.httpStatus
      }
      return status !== 0
        ? new DatabaseError(errorMsg, status)
        : new DatabaseError(errorMsg)
    }
  }

  async delete(address: string) {
    try {
      return await this.provider.collections(this.schema.name).documents().delete(address)
    } catch (error) {
      const errorMsg =
        `Error when deleting nonce entry for address ${address}: ` + error.message
      DATABASE_LOGGER.logMessage(errorMsg, true)
      let status: number
      if (error instanceof TypesenseError) {
        status = error.httpStatus
      }
      return status !== 0
        ? new DatabaseError(errorMsg, status)
        : new DatabaseError(errorMsg)
    }
  }
}

export class IndexerDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<IndexerDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.schema)
        }
      }
      return this
    })() as unknown as IndexerDatabase
  }

  // async create(fields: Record<string, any>) {
  //   try {
  //     return await this.provider.collections(this.schema.name).documents().create(fields)
  //   } catch (error) {
  //     return null
  //   }
  // }

  async create(network: number, lastIndexedBlock: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id: network.toString(), lastIndexedBlock })
    } catch (error) {
      return null
    }
  }

  async retrieve(network: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .retrieve(network.toString())
    } catch (error) {
      return null
    }
  }

  async update(network: number, lastIndexedBlock: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(network.toString(), { lastIndexedBlock })
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schema.name)
          .documents()
          .create({ id: network.toString(), lastIndexedBlock })
      }
      return null
    }
  }

  async delete(network: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .delete(network.toString())
    } catch (error) {
      return null
    }
  }
}

export class LogDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schema: Schema
  ) {
    return (async (): Promise<LogDatabase> => {
      this.provider = new Typesense({
        ...convertTypesenseConfig(this.config.url),
        logger: DATABASE_LOGGER
      })
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          try {
            await this.provider.collections().create(this.schema)
          } catch (creationError) {
            // logger.log(
            // 'info',
            // `Error creating schema for '${this.schema.name}' collection: '${creationError}'`
            // )
          }
        }
      }
      return this
    })() as unknown as LogDatabase
  }

  async insertLog(logEntry: Record<string, any>) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create(logEntry)
    } catch (error) {
      console.error('Error inserting log entry:', error)
      return null
    }
  }

  async retrieveLog(id: string): Promise<Record<string, any> | null> {
    try {
      return await this.provider.collections(this.schema.name).documents().retrieve(id)
    } catch (error) {
      console.error('Error retrieving log entry:', error)
      return null
    }
  }

  async retrieveMultipleLogs(
    startTime: Date,
    endTime: Date,
    maxLogs: number,
    moduleName?: string,
    level?: string
  ): Promise<Record<string, any>[] | null> {
    try {
      let filterConditions = `timestamp:>=${startTime.getTime()} && timestamp:<${endTime.getTime()}`
      if (moduleName) {
        filterConditions += ` && moduleName:${moduleName}`
      }
      if (level) {
        filterConditions += ` && level:${level}`
      }

      const searchParameters = {
        q: '*',
        query_by: 'message,level,meta',
        filter_by: filterConditions,
        sort_by: 'timestamp:desc',
        per_page: maxLogs
      }

      const result = await this.provider
        .collections(this.schema.name)
        .documents()
        .search(searchParameters)
      return result.hits.map((hit) => hit.document)
    } catch (error) {
      console.error('Error retrieving log entries:', error)
      return null
    }
  }
}

export class Database {
  ddo: DdoDatabase
  nonce: NonceDatabase
  indexer: IndexerDatabase
  logs: LogDatabase
  order: OrderDatabase

  constructor(private config: OceanNodeDBConfig) {
    return (async (): Promise<Database> => {
      // add this DB transport too
      // once we create a DB instance, the logger will be using this transport as well
      DATABASE_LOGGER.addTransport(newCustomDBTransport(this))

      this.ddo = await new DdoDatabase(config, schemas.ddoSchemas)
      this.nonce = await new NonceDatabase(config, schemas.nonceSchemas)
      this.indexer = await new IndexerDatabase(config, schemas.indexerSchemas)
      this.logs = await new LogDatabase(config, schemas.logSchemas)
      this.order = await new OrderDatabase(config, schemas.orderSchema)
      return this
    })() as unknown as Database
  }
}
