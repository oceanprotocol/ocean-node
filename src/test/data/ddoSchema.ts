import { TypesenseCollectionCreateSchema } from '../../@types'

export const ddoSchema: TypesenseCollectionCreateSchema = {
  name: 'ddo',
  enable_nested_fields: true,
  fields: [
    { name: '@context', type: 'string[]', optional: true },
    { name: 'chainId', type: 'int64', optional: true },
    { name: 'version', type: 'string', sort: true, optional: true },
    { name: 'nftAddress', type: 'string' },

    { name: 'metadata.description', type: 'string' },
    { name: 'metadata.copyrightHolder', type: 'string', optional: true },
    { name: 'metadata.name', type: 'string', optional: true },
    { name: 'metadata.type', type: 'string', optional: true },
    { name: 'metadata.author', type: 'string', optional: true },
    { name: 'metadata.license', type: 'string', optional: true },
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
