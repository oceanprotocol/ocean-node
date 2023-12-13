import { TypesenseCollectionCreateSchema } from '../../@types/index.js'

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
      fields: [{ name: '.*', type: 'auto', optional: true }] // optional: tru for turning the full version DDO into short one for states DEPRECATED and REVOKED
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
