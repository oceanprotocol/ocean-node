import fs from 'fs'
import { getSchemasFromTtl } from 'shacl-jsonschema-converter'
import { expect } from 'chai'
// avoid override local setup / env variables
const ORIGINAL_PRIVATE_KEY = process.env.PRIVATE_KEY
// '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
const ORIGINAL_IPFS_GATEWAY = process.env.IPFS_GATEWAY
// 'https://ipfs.io/'
const ORIGINAL_ARWEAVE_GATEWAY = process.env.ARWEAVE_GATEWAY
// 'https://arweave.net/'
const ORIGINAL_RPCS = process.env.RPCS
// '{ "1": "https://rpc.eth.gateway.fm", "137": "https://polygon.meowrpc.com", "80001": "https://rpc-mumbai.maticvigil.com" }'

describe('Shacl schema tests', async () => {
  // Implement also here to avoid importing index.ts
  const loadDDOSchemas = () => {
    const schemas: any[] = []
    const dir: string = './dist/components/Indexer/shaclSchemas/v4/'
    fs.readdir(dir, (err, files) => {
      if (err) {
        console.error('Error reading directory for shacl schemas:', err)
        return
      }
      files.forEach((file) => {
        console.log(`Loading schemas from ${file}`, true)
        const jsonSchema = getSchemasFromTtl(file)
        schemas.push(jsonSchema)
      })
    })
    return schemas
  }
  before(() => {
    // dummy private key from barge
    process.env.PRIVATE_KEY =
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    process.env.IPFS_GATEWAY = 'https://ipfs.io/'
    process.env.ARWEAVE_GATEWAY = 'https://arweave.net/'
    process.env.RPCS =
      '{ "1": "https://rpc.eth.gateway.fm", "137": "https://polygon.meowrpc.com", "80001": "https://rpc-mumbai.maticvigil.com" }'
  })

  after(() => {
    // Restore original local setup / env variables after test
    process.env.PRIVATE_KEY = ORIGINAL_PRIVATE_KEY
    process.env.IPFS_GATEWAY = ORIGINAL_IPFS_GATEWAY
    process.env.ARWEAVE_GATEWAY = ORIGINAL_ARWEAVE_GATEWAY
    process.env.RPCS = ORIGINAL_RPCS
  })

  it('Load schemas', () => {
    const list = loadDDOSchemas()
    console.log('list: ', list)
    expect(list.length).to.eql(2)
  })
})
