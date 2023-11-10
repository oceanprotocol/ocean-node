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

    async retrieve(id: string) {
        return await this.provider.collections(this.schemes[0].name).documents().retrieve(id)
    }

    async update(id: string, fields: Record<string, any>) {
        try {
            return await this.provider.collections(this.schemes[0].name).documents().update(id, fields)
        } catch (error) {
            if (error instanceof TypesenseError && error.httpStatus == 404) {
                return await this.provider.collections(this.schemes[0].name).documents().create({id, ...fields})
            } else {
                throw error;
            }
        }

    }

    async delete(id: string) {
        return await this.provider.collections(this.schemes[0].name).documents().delete(id)
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

    async create(id: string, fields: Record<string, any>) {
        try {
            return await this.provider.collections(this.schema.name).documents().create({id, ...fields})
        } catch (error) {
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }

    async retrieve(id: string) {
        try {
            return await this.provider.collections(this.schema.name).documents().retrieve(id)
        } catch (error) {
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }

    async update(id: string, fields: Record<string, any>) {
        try {
            return await this.provider.collections(this.schema.name).documents().update(id, fields)
        } catch (error) {
            if (error instanceof TypesenseError && error.httpStatus == 404) {
                return await this.provider.collections(this.schema.name).documents().create({id, ...fields})
            }
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }

    async delete(id: string) {
        try {
            return await this.provider.collections(this.schema.name).documents().delete(id)
        } catch (error) {
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }
}

export class IndexerDatabase {
    private provider: Typesense

    constructor(private config: OceanNodeDBConfig, private schema: Schema) {
        return (async (): Promise<IndexerDatabase> => {
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
        })() as unknown as IndexerDatabase;
    }

    async create(id: string, fields: Record<string, any>) {
        try {
            return await this.provider.collections(this.schema.name).documents().create({id, ...fields})
        } catch (error) {
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }

    async retrieve(id: string) {
        try {
            return await this.provider.collections(this.schema.name).documents().retrieve(id)
        } catch (error) {
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }

    async update(id: string, fields: Record<string, any>) {
        try {
            return await this.provider.collections(this.schema.name).documents().update(id, fields)
        } catch (error) {
            if (error instanceof TypesenseError && error.httpStatus == 404) {
                return await this.provider.collections(this.schema.name).documents().create({id, ...fields})
            }
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }

    async delete(id: string) {
        try {
            return await this.provider.collections(this.schema.name).documents().delete(id)
        } catch (error) {
            if (error instanceof TypesenseError) {
                return null;
            }
            throw error;
        }
    }
}

export class Database {
    ddo: DdoDatabase
    nonce: NonceDatabase
    indexer: IndexerDatabase

    constructor(private config: OceanNodeDBConfig, schemes: Schemes) {
        return (async (): Promise<Database> => {
            this.ddo = await new DdoDatabase(config, schemes.ddoSchemes)
            this.nonce = await new NonceDatabase(config, schemes.nonceSchema)
            this.indexer = await new IndexerDatabase(config, schemes.indexerSchema)
            return this;
        })() as unknown as Database;
    }
}

// Example
//
// db.nonce.create('0x123', 1234567) return -> { id:'0x123', nonce:1234567 } or throw error
// db.nonce.update('0x123', 1234568) return -> { id:'0x123', nonce:1234568 } or throw error
// db.nonce.retrieve('0x123') return -> 1234568 or throw error
//
// db.indexer.create('Network_A', { last_indexed_block: 1234567 }) return -> { id:'Network_A', last_indexed_block:1234567 } or throw error