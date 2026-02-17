import { expect, assert } from 'chai'
import { ZeroAddress } from 'ethers'
import { nonceSchema } from '../data/nonceSchema.js'
import { Typesense, convertTypesenseConfig } from '../../components/database/typesense.js'

describe('handle nonce', () => {
  let typesense: Typesense
  let error: Error

  before(() => {
    const url = 'http://localhost:8108/?apiKey=xyz'
    typesense = new Typesense(convertTypesenseConfig(url))
  })

  it('instance Typesense', () => {
    expect(typesense).to.be.instanceOf(Typesense)
  })

  it('create nonce collection', async () => {
    let result
    try {
      result = await typesense.collections(nonceSchema.name).retrieve()
    } catch (error) {
      result = await typesense.collections().create(nonceSchema)
    }
    expect(result.enable_nested_fields).to.equal(true)
    expect(result.fields).to.not.be.an('undefined')
    expect(result.name).to.be.equal(nonceSchema.name)
    assert(result.num_documents >= 0, 'num_documents is not a valid number')
  })

  it('should get nonce (1)', async () => {
    const document = await typesense
      .collections(nonceSchema.name)
      .documents()
      .retrieve('0x4cc9DBfc4bEeA8c986c61DAABB350C2eC55e29d1')
    expect(document.nonce).to.be.equal(1)
  })

  it('should throw error for retrieving unexistent address', async () => {
    try {
      await typesense.collections(nonceSchema.name).documents().retrieve(ZeroAddress)
    } catch (err) {
      error = err
    }
    expect(error.message).to.eql(
      'Could not find a document with id: 0x0000000000000000000000000000000000000000'
    )
  })
})
