import { OceanNodeDBConfig } from '../../@types/OceanNode'
import Typesense from './typesense.js'
import { DatabaseDocumentDDO } from '../../@types/Database'

export class Database {
  typesense: Typesense
  private readonly _names: {
    DDO: 'ddo'
    NONCE: 'nonce'
  }

  constructor(private config: OceanNodeDBConfig) {
    this.typesense = new Typesense(config.typesense)
  }

  async createNonce(nonce: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.NONCE).documents().create(nonce)
  }

  async retrieveNonce(nonceId: string): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.NONCE).documents().retrieve(nonceId)
  }

  async updateNonce(
    nonceId: string,
    nonce: Partial<DatabaseDocumentDDO>
  ): Promise<DatabaseDocumentDDO> {
    return this.typesense
      .collections(this._names.NONCE)
      .documents()
      .update(nonceId, nonce)
  }

  async deleteNonce(nonceId: string): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.NONCE).documents().delete(nonceId)
  }

  async createDDO(ddo: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().create(ddo)
  }

  async retrieveDDO(ddoId: string): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().retrieve(ddoId)
  }

  async updateDDO(
    ddoId: string,
    ddo: Partial<DatabaseDocumentDDO>
  ): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().update(ddoId, ddo)
  }

  async deleteDDO(ddoId: string): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().delete(ddoId)
  }
}
