import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { OceanProvider } from '../../components/Provider/index.js'
import { Database } from '../../components/database/index.js'
import { getConfig } from '../../utils/index.js'

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
  let oceanNode: OceanNode
  let config: OceanNodeConfig
  let db: Database
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
    config = await getConfig()
    db = await new Database(config.dbConfig)
    oceanNode = new OceanNode(config, db)
    expect(oceanNode).to.be.instanceOf(OceanNode)
    expect(oceanNode.getConfig().keys.privateKey).to.eql(config.keys.privateKey)
    expect(oceanNode.getConfig().supportedNetworks).to.eql({
      '1': 'https://rpc.eth.gateway.fm',
      '137': 'https://polygon.meowrpc.com',
      '80001': 'https://rpc-mumbai.maticvigil.com'
    })
    expect(oceanNode.getDatabase()).to.not.eql(null)
    expect(oceanNode.getConfig().hasP2P).to.eql(true)
    expect(oceanNode.getConfig().hasIndexer).to.eql(true)
    expect(oceanNode.getConfig().hasProvider).to.eql(true)
  })
  it('Ocean P2P should be initialized correctly', async () => {
    const oceanP2P = oceanNode.getP2PNode()
    expect(oceanP2P).to.be.instanceOf(OceanP2P)
    expect(oceanP2P.getConfig()).to.eql(config)
    expect(oceanP2P.getDatabase()).to.eql(db)
  })
  it('Ocean Indexer should be initialized correctly', async () => {
    const oceanIndexer = oceanNode.getIndexer()
    expect(oceanIndexer).to.be.instanceOf(OceanIndexer)
    expect(oceanIndexer.getSupportedNetworks()).to.eql(config.supportedNetworks)
    // expect(oceanIndexer.getDatabase()).to.eql(db)
  })
  it('Ocean Provider should be initialized correctly', async () => {
    const oceanProvider = oceanNode.getProvider()
    expect(oceanProvider).to.be.instanceOf(OceanProvider)
    expect(oceanProvider.getDatabase()).to.eql(db)
  })
})
