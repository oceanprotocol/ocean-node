import { incorrectDDO, DDOExample } from '../../data/ddo.js'
import { validateObject } from '../../../components/core/utils/validateDdoHandler.js'

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

describe('Schema validation tests', async () => {
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

  it('should pass the validation', async () => {
    const validationResult = await validateObject(DDOExample, 137, DDOExample.nftAddress)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
  it('should not pass the validation', async () => {
    const validationResult = await validateObject(
      incorrectDDO,
      8996,
      DDOExample.nftAddress
    )
    expect(validationResult[0]).to.eql(false)
    expect(validationResult[1]).to.eql({
      metadata: 'Metadata is missing or invalid.',
      id: 'did is not valid for chain Id and nft address'
    })
  })
})
