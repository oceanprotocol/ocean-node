import 'jest'
import Typesense, { TypesenseCollections } from '../../src/components/database/typesense'
import { Logger } from 'winston'
import { TypesenseConfigOptions } from '../../src/@types'
import { ddoSchema } from '../data/ddoSchema'
import { ddo } from '../data/ddo'

describe('Typesense', () => {
  let typesense: Typesense

  beforeAll(() => {
    const config: TypesenseConfigOptions = {
      apiKey: 'xyz',
      nodes: [
        {
          host: 'localhost',
          port: 8108,
          protocol: 'http'
        }
      ]
    }
    typesense = new Typesense(config)
  })

  it('instance Typesense', async () => {
    expect(typesense).toBeInstanceOf(Typesense)
  })

  it('instance TypesenseCollections', async () => {
    const result = typesense.collections()
    expect(result).toBeInstanceOf(TypesenseCollections)
  })
})

describe('Typesense collections', () => {
  let typesense: Typesense

  beforeAll(() => {
    const config: TypesenseConfigOptions = {
      apiKey: 'xyz',
      nodes: [
        {
          host: 'localhost',
          port: 8108,
          protocol: 'http'
        }
      ],
      logLevel: 'debug',
      logger: {
        debug: (log: any) => console.log(log)
      } as Logger
    }
    typesense = new Typesense(config)
  })

  it('create ddo collection', async () => {
    const result = await typesense.collections().create(ddoSchema)
    expect(result.enable_nested_fields).toBeTruthy()
    expect(result.fields).toBeDefined()
    expect(result.name).toEqual(ddoSchema.name)
    expect(result.num_documents).toEqual(0)
  })

  it('retrieve collections', async () => {
    const result = await typesense.collections().retrieve()
    const collection = result[0]
    expect(collection.enable_nested_fields).toBeTruthy()
    expect(collection.fields).toBeDefined()
    expect(collection.name).toEqual(ddoSchema.name)
    expect(collection.num_documents).toEqual(0)
  })

  it('retrieve ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).retrieve()
    expect(result.enable_nested_fields).toBeTruthy()
    expect(result.fields).toBeDefined()
    expect(result.name).toEqual(ddoSchema.name)
    expect(result.num_documents).toEqual(0)
  })

  it('update ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).update({
      fields: [{ name: 'nftAddress', drop: true }]
    })
    expect(result.fields).toBeDefined()
    expect(result.fields[0].drop).toBeTruthy()
    expect(result.fields[0].name).toEqual('nftAddress')
  })

  it('delete ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).delete()
    expect(result.enable_nested_fields).toBeTruthy()
    expect(result.fields).toBeDefined()
    expect(result.name).toEqual(ddoSchema.name)
  })
})

describe('Typesense documents', () => {
  let typesense: Typesense

  beforeAll(() => {
    const config: TypesenseConfigOptions = {
      apiKey: 'xyz',
      nodes: [
        {
          host: 'localhost',
          port: 8108,
          protocol: 'http'
        }
      ],
      logLevel: 'debug',
      logger: {
        debug: (log: any) => console.log(log)
      } as Logger
    }
    typesense = new Typesense(config)
  })

  it('create ddo collection', async () => {
    const result = await typesense.collections().create(ddoSchema)
    expect(result.enable_nested_fields).toBeTruthy()
    expect(result.fields).toBeDefined()
    expect(result.name).toEqual(ddoSchema.name)
    expect(result.num_documents).toEqual(0)
  })

  it('create document in ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).documents().create(ddo)
    expect(result.id).toEqual(ddo.id)
    expect(result.metadata).toBeDefined()
    expect(result.metadata.name).toEqual(ddo.metadata.name)
  })

  it('retrieve document in ddo collection', async () => {
    const result = await typesense
      .collections(ddoSchema.name)
      .documents()
      .retrieve(ddo.id)
    expect(result.id).toEqual(ddo.id)
    expect(result.metadata).toBeDefined()
    expect(result.metadata.name).toEqual(ddo.metadata.name)
  })

  it('update document in ddo collection', async () => {
    const newMetadataName = 'new metadata name'
    const result = await typesense
      .collections(ddoSchema.name)
      .documents()
      .update(ddo.id, {
        metadata: {
          name: newMetadataName
        }
      })
    expect(result.id).toEqual(ddo.id)
    expect(result.metadata).toBeDefined()
    expect(result.metadata.name).toEqual(newMetadataName)
  })

  it('delete document in ddo collection', async () => {
    const newMetadataName = 'new metadata name'
    const result = await typesense.collections(ddoSchema.name).documents().delete(ddo.id)
    expect(result.id).toEqual(ddo.id)
    expect(result.metadata).toBeDefined()
    expect(result.metadata.name).toEqual(newMetadataName)
  })

  it('delete ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).delete()
    expect(result.enable_nested_fields).toBeTruthy()
    expect(result.fields).toBeDefined()
    expect(result.name).toEqual(ddoSchema.name)
  })
})

describe('Typesense documents', () => {
  let typesense: Typesense

  beforeAll(() => {
    const config: TypesenseConfigOptions = {
      apiKey: 'xyz',
      nodes: [
        {
          host: 'localhost',
          port: 8108,
          protocol: 'http'
        }
      ],
      logLevel: 'debug',
      logger: {
        debug: (log: any) => console.log(log)
      } as Logger
    }
    typesense = new Typesense(config)
  })

  it('create ddo collection', async () => {
    const result = await typesense.collections().create(ddoSchema)
    expect(result.enable_nested_fields).toBeTruthy()
    expect(result.fields).toBeDefined()
    expect(result.name).toEqual(ddoSchema.name)
    expect(result.num_documents).toEqual(0)
  })

  it('create document in ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).documents().create(ddo)
    expect(result.id).toEqual(ddo.id)
    expect(result.metadata).toBeDefined()
    expect(result.metadata.name).toEqual(ddo.metadata.name)
  })

  it('search document in ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).documents().search({
      q: 'DEX',
      query_by: 'metadata.name',
      filter_by: 'chainId:<138',
      sort_by: 'version:desc'
    })
    expect(result.found).toEqual(1)
    expect(result.hits[0]).toBeDefined()
    expect(result.hits[0].document).toBeDefined()
  })

  it('delete ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).delete()
    expect(result.enable_nested_fields).toBeTruthy()
    expect(result.fields).toBeDefined()
    expect(result.name).toEqual(ddoSchema.name)
  })
})
