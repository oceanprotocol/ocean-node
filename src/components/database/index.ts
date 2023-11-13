import { OceanNodeDBConfig } from '../../@types/OceanNode'
import {convertTypesenseConfig, Typesense, TypesenseError} from './typesense.js'
import { Schema, schemas} from './schemas.js'

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
      return await this.provider.collections(this.schema.name).documents().retrieve(address)
    } catch (error) {
      return null
    }
  }

  async update(address: string, nonce: number) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .update(address, {nonce})
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

  async create(id: string, fields: Record<string, any>) {
    try {
      return await this.provider
        .collections(this.schema.name)
        .documents()
        .create({ id, ...fields })
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

export class Database {
  ddo: DdoDatabase
  nonce: NonceDatabase
  indexer: IndexerDatabase

  constructor(
    private config: OceanNodeDBConfig
  ) {
    return (async (): Promise<Database> => {
      this.ddo = await new DdoDatabase(config, schemas.ddoSchemas)
      this.nonce = await new NonceDatabase(config, schemas.nonceSchemas)
      this.indexer = await new IndexerDatabase(config, schemas.indexerSchemas)
      return this
    })() as unknown as Database
  }
}

// Example
//
// db.nonce.create('0x123', 1234567) return -> { id:'0x123', nonce:1234567 } or null or throw error
// db.nonce.update('0x123', 1234568) return -> { id:'0x123', nonce:1234568 } or null or throw error
// db.nonce.retrieve('0x123') return -> 1234568 or throw error
//
// db.indexer.create('Network_A', { last_indexed_block: 1234567 }) return -> { id:'Network_A', last_indexed_block:1234567 } or null or throw error
