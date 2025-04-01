import {
  Typesense,
  convertTypesenseConfig,
  TypesenseCollections
} from '../../components/database/typesense.js'
import { ddoSchema } from '../data/ddoSchema.js'
import { ddo } from '../data/ddo.js'
import { expect } from 'chai'
import { TypesenseSearchParams } from '../../@types/index.js'

describe('Typesense', () => {
  let typesense: Typesense

  before(() => {
    const url = 'http://localhost:8108/?apiKey=xyz'
    typesense = new Typesense(convertTypesenseConfig(url))
  })

  it('instance Typesense', () => {
    expect(typesense).to.be.instanceOf(Typesense)
  })

  it('instance TypesenseCollections', () => {
    const result = typesense.collections()
    expect(result).to.be.instanceOf(TypesenseCollections)
  })
})

describe('Typesense collections', () => {
  let typesense: Typesense

  before(() => {
    const url = 'http://localhost:8108/?apiKey=xyz'
    typesense = new Typesense(convertTypesenseConfig(url))
  })

  it('create ddo collection', async () => {
    const result = await typesense.collections().create(ddoSchema)
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.be.equal(ddoSchema.name)
    expect(result.num_documents).to.equal(0)
  })

  it('retrieve collections', async () => {
    const result = await typesense.collections().retrieve()
    const collection = result[0]
    expect(collection.enable_nested_fields).to.equal(true)
    expect(collection.fields).to.not.be.an('undefined')
    expect(collection.name).to.be.equal(ddoSchema.name)
    expect(collection.num_documents).to.equal(0)
  })

  it('retrieve ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).retrieve()
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.be.equal(ddoSchema.name)
    expect(result.num_documents).to.equal(0)
  })

  it('update ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).update({
      fields: [{ name: 'nftAddress', drop: true }]
    })
    expect(result.fields).to.not.be.an('undefined')
    expect(result.fields[0].drop).to.equal(true)
    expect(result.fields[0].name).to.be.equal('nftAddress')
  })

  it('delete ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).delete()
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.be.equal(ddoSchema.name)
  })
})

describe('Typesense documents', () => {
  let typesense: Typesense

  before(() => {
    const url = 'http://localhost:8108/?apiKey=xyz'
    typesense = new Typesense(convertTypesenseConfig(url))
  })

  it('create ddo collection', async () => {
    const result = await typesense.collections().create(ddoSchema)
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.be.equal(ddoSchema.name)
    expect(result.num_documents).to.equal(0)
  })

  it('create document in ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).documents().create(ddo)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(ddo.metadata.name)
  })

  it('retrieve document in ddo collection', async () => {
    const result = await typesense
      .collections(ddoSchema.name)
      .documents()
      .retrieve(ddo.id)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(ddo.metadata.name)
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
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(newMetadataName)
  })

  it('delete document in ddo collection', async () => {
    const newMetadataName = 'new metadata name'
    const result = await typesense.collections(ddoSchema.name).documents().delete(ddo.id)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(newMetadataName)
  })

  it('delete ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).delete()
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.equal(ddoSchema.name)
  })
})

describe('Typesense documents', () => {
  let typesense: Typesense

  before(() => {
    const url = 'http://localhost:8108/?apiKey=xyz'
    typesense = new Typesense(convertTypesenseConfig(url))
  })

  it('create ddo collection', async () => {
    const result = await typesense.collections().create(ddoSchema)
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.be.equal(ddoSchema.name)
    expect(result.num_documents).to.equal(0)
  })

  it('create document in ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).documents().create(ddo)
    expect(result.id).to.equal(ddo.id)
    expect(result.metadata).to.not.be.an('undefined')
    expect(result.metadata.name).to.be.equal(ddo.metadata.name)
  })
  it('search document in ddo collection', async () => {
    const queryParams: TypesenseSearchParams = {
      q: 'new metadata name',
      query_by: 'metadata.name',
      filter_by: 'chainId:=137',
      sort_by: 'version:desc'
    }
    const result = await typesense
      .collections(ddoSchema.name)
      .documents()
      .search(queryParams)

    expect(result.found).to.equal(1)
    expect(result.hits[0]).to.not.be.an('undefined')
    expect(result.hits[0].document).to.not.be.an('undefined')
  })

  it('delete ddo collection', async () => {
    const result = await typesense.collections(ddoSchema.name).delete()
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.be.equal(ddoSchema.name)
  })
})
