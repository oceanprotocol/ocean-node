import { TypesenseCollectionCreateSchema } from '../../src/@types'

export const orderSchema: TypesenseCollectionCreateSchema = {
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
