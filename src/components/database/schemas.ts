import { TypesenseCollectionCreateSchema } from '../../@types/Typesense.js'

export type Schema = TypesenseCollectionCreateSchema
export type Schemas = {
  ddoSchemas: Schema[]
  nonceSchemas: Schema
  indexerSchemas: Schema
}
export const schemas: Schemas = {
  ddoSchemas: [
    {
      name: 'ddo_v0.1',
      enable_nested_fields: true,
      fields: [{ name: '.*', type: 'auto' }]
    }
  ],
  nonceSchemas: {
    name: 'nonce',
    enable_nested_fields: true,
    fields: [{ name: 'nonce', type: 'int64' }]
  },
  indexerSchemas: {
    name: 'indexer',
    enable_nested_fields: true,
    fields: [{ name: 'lastIndexedBlock', type: 'int64' }]
  }
}
