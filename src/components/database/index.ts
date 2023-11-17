import { OceanNodeDBConfig } from '../../@types/OceanNode'
import { convertTypesenseConfig, Typesense, TypesenseError } from './typesense.js'
import { Schema, schemas } from './schemas.js'

export class DdoDatabase {
  private provider: Typesense

  constructor(
    private config: OceanNodeDBConfig,
    private schemas: Schema[]
  ) {
    return (async (): Promise<DdoDatabase> => {
      this.provider = new Typesense(convertTypesenseConfig(this.config.url))
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

  async create(ddo: Record<string, any>) {
    try {
      return await this.provider.collections(this.schemas[0].name).documents().create(ddo)
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

  async update(id: string, fields: Record<string, any>) {
    try {
      return await this.provider
        .collections(this.schemas[0].name)
        .documents()
        .update(id, fields)
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schemas[0].name)
          .documents()
          .create({ id, ...fields })
      }
      return null
    }
  }

  async delete(id: string) {
    try {
      return await this.provider.collections(this.schemas[0].name).documents().delete(id)
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
      this.provider = new Typesense(convertTypesenseConfig(this.config.url))
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
      return null
    }
  }

  async retrieve(address: string) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .retrieve(address)
    } catch (error) {
      return null
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
      return null
    }
  }

  async delete(address: string) {
    try {
      return await this.provider.collections(this.schema.name).documents().delete(address)
    } catch (error) {
      return null
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
      this.provider = new Typesense(convertTypesenseConfig(this.config.url))
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

  async create(fields: Record<string, any>) {
    try {
      return await this.provider.collections(this.schema.name).documents().create(fields)
    } catch (error) {
      return null
    }
  }

  async retrieve(id: string) {
    try {
      return await this.provider.collections(this.schema.name).documents().retrieve(id)
    } catch (error) {
      return null
    }
  }

  async update(id: string, fields: Record<string, any>) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(id, fields)
    } catch (error) {
      if (error instanceof TypesenseError && error.httpStatus === 404) {
        return await this.provider
          .collections(this.schema.name)
          .documents()
          .create({ id, ...fields })
      }
      return null
    }
  }

  async delete(id: string) {
    try {
      return await this.provider.collections(this.schema.name).documents().delete(id)
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
      this.provider = new Typesense(convertTypesenseConfig(this.config.url))
      try {
        await this.provider.collections(this.schema.name).retrieve()
      } catch (error) {
        if (error instanceof TypesenseError && error.httpStatus === 404) {
          await this.provider.collections().create(this.schema)
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
}

export class Database {
  ddo: DdoDatabase
  nonce: NonceDatabase
  indexer: IndexerDatabase
  logs: LogDatabase

  constructor(private config: OceanNodeDBConfig) {
    return (async (): Promise<Database> => {
      this.ddo = await new DdoDatabase(config, schemas.ddoSchemas)
      this.nonce = await new NonceDatabase(config, schemas.nonceSchemas)
      this.indexer = await new IndexerDatabase(config, schemas.indexerSchemas)
      this.logs = await new LogDatabase(config, schemas.logSchemas)
      return this
    })() as unknown as Database
  }
}
