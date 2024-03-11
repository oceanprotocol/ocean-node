import { expect, assert } from 'chai'
import { ethers, ZeroAddress } from 'ethers'
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

  it('should validate signature', async () => {
    try {
      await typesense
        .collections(nonceSchema.name)
        .documents()
        .retrieve('0x4cc9DBfc4bEeA8c986c61DAABB350C2eC55e29d1')
      // if not, create it now
    } catch (ex) {
      await typesense.collections(nonceSchema.name).documents().create({
        id: '0x4cc9DBfc4bEeA8c986c61DAABB350C2eC55e29d1',
        nonce: 1
      })
    }
    const wallet = new ethers.Wallet(
      '0xbee525d70c715bee6ca15ea5113e544d13cc1bb2817e07113d0af7755ddb6391'
    )
    // message to sign
    const nonce = '1'
    const expectedAddress = await wallet.getAddress()
    // '0x8F292046bb73595A978F4e7A131b4EBd03A15e8a'
    // sign message/nonce
    const signature = await wallet.signMessage(nonce)
    const actualAddress = ethers.verifyMessage(nonce, signature)
    expect(actualAddress).to.be.equal(expectedAddress)
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
