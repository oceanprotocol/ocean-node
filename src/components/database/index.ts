import {OceanNodeDBConfig} from '../../@types/OceanNode'
import {Typesense, TypesenseError} from './typesense.js'
import {Schemes, Schema} from "./schemes.js";

export class DdoDatabase {
    private provider: Typesense

    constructor(private config: OceanNodeDBConfig, private schemes: Schema[]) {
        return (async (): Promise<DdoDatabase> => {
            this.provider = new Typesense(this.config.typesense)
            for (const ddoSchema of this.schemes) {
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
            return this;
        })() as unknown as DdoDatabase;
    }

    async create(ddo: Record<string, any>) {
        return await this.provider.collections(this.schemes[0].name).documents().create(ddo)
    }

    async update(id: string, ddo: Record<string, any>) {
        return await this.provider.collections(this.schemes[0].name).documents().update(id, ddo)
    }

    async retrieve(id: string) {
        return await this.provider.collections(this.schemes[0].name).documents().retrieve(id)
    }

}

export class NonceDatabase {
    private provider: Typesense

    constructor(private config: OceanNodeDBConfig, private schema: Schema) {
        return (async (): Promise<NonceDatabase> => {
            this.provider = new Typesense(this.config.typesense)
            try {
                await this.provider.collections(this.schema.name).retrieve()
            } catch (error) {
                if (error instanceof TypesenseError && error.httpStatus == 404) {
                    await this.provider.collections().create(this.schema)
                } else {
                    throw error;
                }
            }
            return this;
        })() as unknown as NonceDatabase;
    }

    async create(id: string, nonce: number) {
        return await this.provider.collections(this.schema.name).documents().create({id, nonce})
    }

    async update(id: string, nonce: number) {
        return await this.provider.collections(this.schema.name).documents().update(id, {nonce})
    }

    async retrieve(id: string) {
        const result = await this.provider.collections(this.schema.name).documents().retrieve(id)
        return result.nonce
    }

}

// export class IndexerDatabase {
//     private provider: Typesense
//
//     constructor(private config: OceanNodeDBConfig, indexerSchema: Schema) {
//         this.provider = new Typesense(this.config.typesense)
//     }
//
//     async init(indexerSchema: Schema) {
//         // const result = await this.provider.collections().create(ddoSchemes)
//     }
// }

export class Database {
    ddo: DdoDatabase
    nonce: NonceDatabase
    // indexer: IndexerDatabase

    constructor(private config: OceanNodeDBConfig, schemes: Schemes) {
        return (async (): Promise<Database> => {
            this.ddo = await new DdoDatabase(config, schemes.ddoSchemes)
            this.nonce = await new NonceDatabase(config, schemes.nonceSchema)
            // this.indexer = new IndexerDatabase(config, schemes.indexerSchema)
            return this;
        })() as unknown as Database;
    }
}

// Example
// db.nonce.create('0x123', 1234567) return -> { id:'0x123', nonce:1234567 } or throw error
// db.nonce.update('0x123', 1234568) return -> { id:'0x123', nonce:1234568 } or throw error
// db.nonce.retrieve('0x123') return -> 1234568 or throw error