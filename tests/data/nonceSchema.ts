import { TypesenseCollectionCreateSchema } from '../../@types'

export const nonceSchema: TypesenseCollectionCreateSchema = {
  name: 'nonce',
  enable_nested_fields: true,
  fields: [
    { name: 'id', type: 'string' },
    { name: 'nonce', type: 'int64', sort: true } // store nonce as string
  ]
}
