import {OceanNodeDBConfig} from '../../@types/OceanNode'
import {Typesense, TypesenseError} from './typesense.js'
import {Schemes, Schema} from "./schemes.js";

export class DdoDatabase {
    private provider: Typesense
    private names: string[]

    constructor(private config: OceanNodeDBConfig) {
        this.provider = new Typesense(this.config.typesense)
    }

    async init(ddoSchemes: Schema[]) {
        this.names = ddoSchemes.map(schema => schema.name)
        for (const ddoSchema of ddoSchemes) {
            try {
                await this.provider.collections(ddoSchema.name).retrieve()
            } catch (error) {
                if (error instanceof TypesenseError && error.httpStatus == 404) {
                    await this.provider.collections().create(ddoSchema)
                } else {
                    throw error;
                }
            }
        }
    }

    async create(ddo: Record<string, any>) {
        return await this.provider.collections(this.names[0]).documents().create(ddo)
    }

    async update(id: string, ddo: Record<string, any>) {
        return await this.provider.collections(this.names[0]).documents().update(id, ddo)
    }

    async retrieve(id: string) {
        return await this.provider.collections(this.names[0]).documents().retrieve(id)
    }

}

export class NonceDatabase {
    private provider: Typesense
    private name: string

    constructor(private config: OceanNodeDBConfig) {
        this.provider = new Typesense(this.config.typesense)
    }

    async init(nonceSchema: Schema) {
        this.name = nonceSchema.name
        try {
            await this.provider.collections(nonceSchema.name).retrieve()
        } catch (error) {
            if (error instanceof TypesenseError && error.httpStatus == 404) {
                await this.provider.collections().create(nonceSchema)
            } else {
                throw error;
            }
        }
    }

    async create(id: string, nonce: number) {
        return await this.provider.collections(this.name).documents().create({id, nonce})
    }

    async update(id: string, nonce: number) {
        return await this.provider.collections(this.name).documents().update(id, {nonce})
    }

    async retrieve(id: string) {
        const result = await this.provider.collections(this.name).documents().retrieve(id)
        return result.nonce
    }

}

export class IndexerDatabase {
    private provider: Typesense

    constructor(private config: OceanNodeDBConfig) {
        this.provider = new Typesense(this.config.typesense)
    }

    async init(indexerSchema: Schema) {
        // const result = await this.provider.collections().create(ddoSchemes)
    }
}

export class Database {
    ddo: DdoDatabase
    nonce: NonceDatabase
    indexer: IndexerDatabase

    constructor(private config: OceanNodeDBConfig) {
        this.ddo = new DdoDatabase(config)
        this.nonce = new NonceDatabase(config)
        this.indexer = new IndexerDatabase(config)
    }

    async init(schemes: Schemes) {
        await this.ddo.init(schemes.ddoSchemes)
        await this.nonce.init(schemes.nonceSchema)
        await this.indexer.init(schemes.indexerSchema)
    }
}

// Example
// db.nonce.create('0x123', 1234567) return -> { id:'0x123', nonce:1234567 } or throw error
// db.nonce.update('0x123', 1234568) return -> { id:'0x123', nonce:1234568 } or throw error
// db.nonce.retrieve('0x123') return -> 1234568 or throw error