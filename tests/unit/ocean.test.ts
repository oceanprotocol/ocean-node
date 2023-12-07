import { OceanNode } from '../../src/OceanNode.js'
import { getConfig } from '../../src/utils/index.js'

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

describe('Status command tests', () => {
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

  it('Ocean Node instance', async () => {
    const config = await getConfig()
    const oceanNode = new OceanNode(config)
    expect(oceanNode).to.be.instanceOf(OceanNode)
    expect(oceanNode.getConfig().keys.privateKey).to.eql(config.keys.privateKey)
    expect(oceanNode.getConfig().supportedNetworks).to.eql({
      '1': 'https://rpc.eth.gateway.fm',
      '137': 'https://polygon.meowrpc.com',
      '80001': 'https://rpc-mumbai.maticvigil.com'
    })
    expect(oceanNode.getDatabase()).to.not.eql(null)
    if (config.hasP2P) {
      expect(oceanNode.getP2PNode()).to.not.eql(null)
    }
    if (config.hasIndexer) {
      expect(oceanNode.getIndexer()).to.not.eql(null)
    }
    if (config.hasProvider) {
      expect(oceanNode.getProvider()).to.not.eql(null)
    }
  })
})
