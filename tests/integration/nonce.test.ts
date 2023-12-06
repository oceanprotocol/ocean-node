import { expect } from 'chai'
import { ethers } from 'ethers'
import { nonceSchema } from '../data/nonceSchema.js'
import {
  Typesense,
  convertTypesenseConfig
} from '../../src/components/database/typesense'

describe('handle nonce', () => {
  let typesense: Typesense

  before(() => {
    const url = 'http://localhost:8108/?apiKey=xyz'
    typesense = new Typesense(convertTypesenseConfig(url))
  })

  it('instance Typesense', async () => {
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
    expect(result.num_documents).to.equal(0)
  })

  it('should validate signature', async () => {
    try {
      await typesense
        .collections(nonceSchema.name)
        .documents()
        .retrieve('0x4cc9DBfc4bEeA8c986c61DAABB350C2eC55e29d1')
      console.log('document in checkDocumentExists: ', document)
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
      .collections('nonce')
      .documents()
      .retrieve('0x4cc9DBfc4bEeA8c986c61DAABB350C2eC55e29d1')
    expect(document.nonce).to.be.equal(1)
  })
})
