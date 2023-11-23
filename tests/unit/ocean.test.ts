import { OceanNode } from '../../src/OceanNode.js'
import { getConfig } from '../../src/utils/index.js'

import { expect } from 'chai'

describe('Status command tests', async () => {
  before(() => {
    // dummy private key from barge
    process.env.PRIVATE_KEY =
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58'
    process.env.IPFS_GATEWAY = 'https://ipfs.io/'
    process.env.ARWEAVE_GATEWAY = 'https://arweave.net/'
    process.env.RPCS =
      '{ "1": "https://rpc.eth.gateway.fm", "137": "https://polygon.meowrpc.com", "80001": "https://rpc-mumbai.maticvigil.com" }'
  })
  const config = await getConfig()
  const oceanNode = new OceanNode(config)

  it('Ocean Node instance', () => {
    expect(oceanNode).to.be.instanceOf(OceanNode)
  })

  it('should get config successfully', () => {
    expect(oceanNode.getConfig().keys.privateKey).to.eql(config.keys.privateKey)
    expect(oceanNode.getConfig().supportedNetworks).to.eql({
      '1': 'https://rpc.eth.gateway.fm',
      '137': 'https://polygon.meowrpc.com',
      '80001': 'https://rpc-mumbai.maticvigil.com'
    })
  })
})
