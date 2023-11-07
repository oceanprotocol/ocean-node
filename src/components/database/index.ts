import { OceanNodeDBConfig } from '../../@types/OceanNode'
import Typesense from "./typesense";
import {DatabaseDocumentDDO} from "../../@types/Database";

export class Database {
  typesense: Typesense
  private readonly _names: {
    DDO: 'ddo',
    NONCE: 'nonce',
  }
  constructor(private config: OceanNodeDBConfig) {
    this.typesense = new Typesense(config.typesense)
  }

  async createNonce(ddo: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().create(ddo);
  }

  async retrieveNonce(ddo: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().retrieve(ddo.id);
  }

  async updateNonce(ddoId: string, ddo: Partial<DatabaseDocumentDDO>): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().update(ddoId, ddo);
  }

  async deleteNonce(ddo: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().delete(ddo.id);
  }

  async createDDO(ddo: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().create(ddo);
  }

  async retrieveDDO(ddo: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().retrieve(ddo.id);
  }

  async updateDDO(ddoId: string, ddo: Partial<DatabaseDocumentDDO>): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().update(ddoId, ddo);
  }

  async deleteDDO(ddo: DatabaseDocumentDDO): Promise<DatabaseDocumentDDO> {
    return this.typesense.collections(this._names.DDO).documents().delete(ddo.id);
  }
}
