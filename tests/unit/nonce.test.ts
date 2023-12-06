import { expect } from 'chai'
import { ethers } from 'ethers'
import { TypesenseCollectionCreateSchema } from '../../src/@types/Typesense'
import {
  Typesense,
  convertTypesenseConfig
} from '../../src/components/database/typesense'

const nonceSchema: TypesenseCollectionCreateSchema = {
  name: 'nonce',
  enable_nested_fields: true,
  fields: [
    { name: 'id', type: 'string' },
    { name: 'nonce', type: 'int64', sort: true } // store nonce as string
  ]
}

async function createNonceCollection(typesense: Typesense) {
  return await typesense.collections().create(nonceSchema)
}

// creates if needed
async function checkDocumentExists(typesense: Typesense) {
  let document
  try {
    document = await typesense
      .collections('nonce')
      .documents()
      .retrieve('0x4cc9DBfc4bEeA8c986c61DAABB350C2eC55e29d1')
    console.log('document in checkDocumentExists: ', document)
    // if not, create it now
  } catch (ex) {
    console.log('caught ex in checkDocumentExists: ', ex)
    await typesense.collections('nonce').documents().create({
      id: '0x4cc9DBfc4bEeA8c986c61DAABB350C2eC55e29d1',
      nonce: 1
    })
    console.log('document in checkDocumentExists after creating: ', document)
  }
}
describe('handle nonce', () => {
  let typesense: Typesense

  before(async () => {
    const url = 'http://localhost:8108/?apiKey=xyz'
    typesense = new Typesense(convertTypesenseConfig(url))

    const existingCollections = await typesense.collections().retrieve()
    console.log('existingCollections: ', existingCollections)
    // check existing ones
    if (existingCollections && existingCollections.length > 0) {
      let existsNonceCollection = true
      try {
        await typesense.collections(nonceSchema.name).retrieve()
      } catch (error) {
        existsNonceCollection = false
        // collection nonce not exists'
      }
    }

    //   if (existsNonceCollection) {
    //     // check if the document exists
    //     await checkDocumentExists(typesense)
    //   } else {
    //     // create collection and document if needed
    //     await createNonceCollection(typesense)
    //     await checkDocumentExists(typesense)
    //   }
    // } else {
    //   // create collection and document
    //   await createNonceCollection(typesense)
    //   await checkDocumentExists(typesense)
    // }
  })

  it('should validate signature', async () => {
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
