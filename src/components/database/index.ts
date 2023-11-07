import { OceanNodeDBConfig } from '../../@types/OceanNode'
import Typesense from './typesense.js'
import {TypesenseCollectionFieldSchema, TypesenseDocumentSchema} from "../../@types";

export class Database {
  typesense: Typesense
  private readonly _names: {
    DDO: 'ddo'
    NONCE: 'nonce'
  }

  constructor(private config: OceanNodeDBConfig) {
    this.typesense = new Typesense(config.typesense)
  }

  async createCollectionNonce(fields: TypesenseCollectionFieldSchema[]): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections().create({
      name: this._names.NONCE,
      enable_nested_fields: true,
      fields
    })
  }

  async retrieveCollectionNonce(): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.NONCE).retrieve()
  }

  async createNonce(nonce: TypesenseDocumentSchema): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.NONCE).documents().create(nonce)
  }

  async retrieveNonce(nonceId: string): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.NONCE).documents().retrieve(nonceId)
  }

  async updateNonce(
    nonceId: string,
    nonce: Partial<TypesenseDocumentSchema>
  ): Promise<TypesenseDocumentSchema> {
    return this.typesense
      .collections(this._names.NONCE)
      .documents()
      .update(nonceId, nonce)
  }

  async deleteNonce(nonceId: string): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.NONCE).documents().delete(nonceId)
  }

  async createCollectionDDO(fields: TypesenseCollectionFieldSchema[]): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections().create({
      name: this._names.DDO,
      enable_nested_fields: true,
      fields
    })
  }

  async retrieveCollectionDDO(): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.DDO).retrieve()
  }

  async createDDO(ddo: TypesenseDocumentSchema): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.DDO).documents().create(ddo)
  }

  async retrieveDDO(ddoId: string): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.DDO).documents().retrieve(ddoId)
  }

  async updateDDO(
    ddoId: string,
    ddo: Partial<TypesenseDocumentSchema>
  ): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.DDO).documents().update(ddoId, ddo)
  }

  async deleteDDO(ddoId: string): Promise<TypesenseDocumentSchema> {
    return this.typesense.collections(this._names.DDO).documents().delete(ddoId)
  }
}
