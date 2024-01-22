import { OceanNode } from '../../OceanNode.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { OceanProvider } from '../../components/Provider/index.js'
import { Database } from '../../components/database/index.js'
import { ENVIRONMENT_VARIABLES, getConfig } from '../../utils/index.js'

import { expect } from 'chai'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

let envOverrides: OverrideEnvConfig[]

describe('Status command tests', async () => {
  // need to do it first
  envOverrides = buildEnvOverrideConfig(
    [
      ENVIRONMENT_VARIABLES.PRIVATE_KEY,
      ENVIRONMENT_VARIABLES.IPFS_GATEWAY,
      ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY,
      ENVIRONMENT_VARIABLES.RPCS
    ],
    [
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
      'https://ipfs.io/',
      'https://arweave.net/',
      '{ "1": "https://rpc.eth.gateway.fm", "137": "https://polygon.meowrpc.com", "80001": "https://rpc-mumbai.maticvigil.com" }'
    ]
  )
  envOverrides = await setupEnvironment(null, envOverrides)
  // because of this
  const config = await getConfig()
  const db = await new Database(config.dbConfig)
  const oceanNode = OceanNode.getInstance(config, db)
  const oceanP2P = new OceanP2P(config, db)
  const oceanIndexer = new OceanIndexer(db, config.supportedNetworks)
  const oceanProvider = new OceanProvider(db)

  after(() => {
    // Restore original local setup / env variables after test
    tearDownEnvironment(envOverrides)
  })

  it('Ocean Node instance', () => {
    expect(oceanNode).to.be.instanceOf(OceanNode)
    expect(config.supportedNetworks).to.eql({
      '1': 'https://rpc.eth.gateway.fm',
      '137': 'https://polygon.meowrpc.com',
      '80001': 'https://rpc-mumbai.maticvigil.com'
    })
    expect(oceanNode.getDatabase()).to.not.eql(null)
    expect(config.hasP2P).to.eql(true)
    expect(config.hasIndexer).to.eql(true)
    expect(config.hasProvider).to.eql(true)
  })
  it('Ocean P2P should be initialized correctly', async () => {
    oceanNode.addP2PNode(oceanP2P)
    expect(oceanNode.getP2PNode().getDatabase()).to.eql(db)
  })
  it('Ocean Indexer should be initialized correctly', async () => {
    oceanNode.addIndexer(oceanIndexer)
    expect(oceanNode.getIndexer().getSupportedNetworks()).to.eql(config.supportedNetworks)
    expect(oceanNode.getIndexer().getDatabase()).to.eql(db)
  })
  it('Ocean Provider should be initialized correctly', async () => {
    oceanNode.addProvider(oceanProvider)
    expect(oceanNode.getProvider().getDatabase()).to.eql(db)
  })
})
