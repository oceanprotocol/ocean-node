import { OceanNode } from '../../OceanNode.js'
import { OceanIndexer } from '../../components/Indexer/index.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { BlockchainRegistry } from '../../components/BlockchainRegistry/index.js'
import { OceanProvider } from '../../components/Provider/index.js'
import { Database } from '../../components/database/index.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'

import { expect } from 'chai'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

let envOverrides: OverrideEnvConfig[]

// NOTE: this describe callback is intentionally synchronous. A previous version used an
// `async () => { ... await ... }` describe body, which mocha does NOT await: the `it`/`after`
// registrations ran on a later microtask and the suite's `after` hook ended up executing
// interleaved with the global root `afterAll` (test/utils/hooks.ts). By then the global hook
// had already torn the environment down (CONFIG_PATH/PRIVATE_KEY cleared), so the `after`
// hook's tearDownEnvironment -> getConfiguration(true) reload threw
// "Config path must be absolute. Got: undefined". All async setup now lives in before().
describe('Status command tests', () => {
  let config: Awaited<ReturnType<typeof getConfiguration>>
  let db: Awaited<ReturnType<typeof Database.init>>
  let oceanIndexer: OceanIndexer
  let oceanProvider: OceanProvider
  let oceanNode: OceanNode

  before(async () => {
    // need to do it first
    envOverrides = buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.PRIVATE_KEY,
        ENVIRONMENT_VARIABLES.IPFS_GATEWAY,
        ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY,
        ENVIRONMENT_VARIABLES.RPCS,
        ENVIRONMENT_VARIABLES.INDEXER_NETWORKS
      ],
      [
        '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
        'https://ipfs.io/',
        'https://arweave.net/',
        '{ "1": "https://rpc.eth.gateway.fm", "137": "https://polygon.meowrpc.com" }',
        JSON.stringify([1, 137])
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    // because of this
    config = await getConfiguration(true)
    db = await Database.init(config.dbConfig)
    const keyManager = new KeyManager(config)
    const blockchainRegistry = new BlockchainRegistry(keyManager, config)
    const oceanP2P = new OceanP2P(config, keyManager, db)
    oceanIndexer = new OceanIndexer(db, config, blockchainRegistry)
    oceanProvider = new OceanProvider(db)
    // Force a fresh instance (newInstance=true): OceanNode is a singleton and, now that this
    // setup runs in before() rather than at collection time, an earlier suite may already have
    // created the instance without a P2P node. Without this, getInstance() would return that
    // cached node and getP2PNode() would be null.
    oceanNode = OceanNode.getInstance(
      config,
      db,
      oceanP2P,
      undefined,
      undefined,
      keyManager,
      blockchainRegistry,
      true
    )
  })

  after(async () => {
    // Restore original local setup / env variables after test
    await tearDownEnvironment(envOverrides)
    await oceanIndexer.stopAllChainIndexers()
  })

  it('Ocean Node instance', () => {
    expect(oceanNode).to.be.instanceOf(OceanNode)
    expect(config.supportedNetworks).to.eql({
      '1': 'https://rpc.eth.gateway.fm',
      '137': 'https://polygon.meowrpc.com'
    })
    expect(oceanNode.getDatabase()).to.not.eql(null)
    expect(config.hasP2P).to.eql(true)
    expect(config.hasIndexer).to.eql(true)
  })
  it('Ocean P2P should be initialized correctly', () => {
    expect(oceanNode.getP2PNode()).to.not.eql(null)
    expect(OceanNode.getInstance(config, db).getP2PNode()).to.not.eql(null)
  })
  it('Ocean Indexer should be initialized correctly', () => {
    oceanNode.addIndexer(oceanIndexer)
    expect(oceanNode.getIndexer().getSupportedNetworks()).to.eql(config.indexingNetworks)
    expect(oceanNode.getIndexer().getDatabase()).to.eql(db)
  })
  it('Ocean Provider should be initialized correctly', () => {
    oceanNode.addProvider(oceanProvider)
    expect(oceanNode.getProvider().getDatabase()).to.eql(db)
  })
})
