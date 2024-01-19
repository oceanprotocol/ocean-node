import { TypesenseCollectionCreateSchema } from '../../@types/index.js'

export type Schema = TypesenseCollectionCreateSchema
export type Schemas = {
  ddoSchemas: Schema[]
  nonceSchemas: Schema
  indexerSchemas: Schema
  logSchemas: Schema
  orderSchema: Schema
}
export const schemas: Schemas = {
  ddoSchemas: [
    {
      name: 'op_ddo_v5_1',
      enable_nested_fields: true,
      fields: [{ name: '.*', type: 'auto', optional: true }] // optional: true for turning the full version DDO into short one for states DEPRECATED and REVOKED
    },
    {
      name: 'op_ddo_v3',
      enable_nested_fields: true,
      fields: [{ name: '.*', type: 'auto', optional: true }] // optional: true for turning the full version DDO into short one for states DEPRECATED and REVOKED
    },
    {
      name: 'op_ddo_v1',
      enable_nested_fields: true,
      fields: [{ name: '.*', type: 'auto', optional: true }] // optional: true for turning the full version DDO into short one for states DEPRECATED and REVOKED
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
  },
  orderSchema: {
    name: 'order',
    enable_nested_fields: true,
    fields: [
      { name: 'type', type: 'string', enum: ['startOrder', 'reuseOrder'] },
      { name: 'timestamp', type: 'int64' },
      { name: 'consumer', type: 'string' },
      { name: 'payer', type: 'string' },
      {
        name: 'startOrderId',
        type: 'string',
        optional: true,
        dependencies: { type: ['reuseOrder'] }
      }
    ]
  }
}
