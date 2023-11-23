import { OceanNodeDBConfig } from '../../@types/OceanNode'
import { convertTypesenseConfig, Typesense, TypesenseError } from './typesense.js'
import { Schema, schemas } from './schemas.js'
import { TypesenseSearchParams } from '../../@types'

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

export class Database {
  ddo: DdoDatabase
  nonce: NonceDatabase
  indexer: IndexerDatabase

  constructor(private config: OceanNodeDBConfig) {
    return (async (): Promise<Database> => {
      this.ddo = await new DdoDatabase(config, schemas.ddoSchemas)
      this.nonce = await new NonceDatabase(config, schemas.nonceSchemas)
      this.indexer = await new IndexerDatabase(config, schemas.indexerSchemas)
      return this
    })() as unknown as Database
  }
}
