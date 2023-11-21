import { TypesenseCollectionCreateSchema } from '../../@types'

export type Schema = TypesenseCollectionCreateSchema
export type Schemas = {
  ddoSchemas: Schema[]
  nonceSchemas: Schema
  indexerSchemas: Schema
  logSchemas: Schema
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
    fields: [{ name: '.*', type: 'auto' }]
  },
  logSchemas: {
    name: 'logs',
    enable_nested_fields: true,
    fields: [
      { name: 'timestamp', type: 'int64', sort: true },
      { name: 'level', type: 'string' },
      { name: 'message', type: 'string' },
      { name: 'moduleName', type: 'string', optional: true },
      { name: 'meta', type: 'string', optional: true }
    ]
  }
}
