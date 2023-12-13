import { TypesenseCollectionCreateSchema } from '../../@types'

export const ddoSchema: TypesenseCollectionCreateSchema = {
  name: 'ddo',
  enable_nested_fields: true,
  fields: [
    { name: '@context', type: 'string[]' },
    { name: 'chainId', type: 'int64' },
    { name: 'version', type: 'string', sort: true },
    { name: 'nftAddress', type: 'string' },

    { name: 'metadata.description', type: 'string' },
    { name: 'metadata.copyrightHolder', type: 'string', optional: true },
    { name: 'metadata.name', type: 'string' },
    { name: 'metadata.type', type: 'string' },
    { name: 'metadata.author', type: 'string' },
    { name: 'metadata.license', type: 'string' },
    { name: 'metadata.links', type: 'string', optional: true },
    { name: 'metadata.tags', type: 'string[]', optional: true },
    { name: 'metadata.categories', type: 'string', optional: true },
    { name: 'metadata.contentLanguage', type: 'string', optional: true },
    { name: 'metadata.algorithm.version', type: 'string', optional: true },
    { name: 'metadata.algorithm.language', type: 'string', optional: true },
    { name: 'metadata.algorithm.container.entrypoint', type: 'string', optional: true },
    { name: 'metadata.algorithm.container.image', type: 'string', optional: true },
    { name: 'metadata.algorithm.container.tag', type: 'string', optional: true },
    { name: 'metadata.algorithm.container.checksum', type: 'string', optional: true }
  ]
}
