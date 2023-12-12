import { TypesenseCollectionCreateSchema } from '../../src/@types'

export const orderSchema: TypesenseCollectionCreateSchema = {
  name: 'order',
  enable_nested_fields: true,
  fields: [
    { name: 'orderTx', type: 'string' },
    { name: 'consumer', type: 'string' },
    { name: 'payer', type: 'string' },
    { name: 'validity', type: 'int64' }
  ]
}
