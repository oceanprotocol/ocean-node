import { assert } from 'chai'
import { getConfiguration } from '../../utils/config.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { delay } from '../integration/testUtils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'

describe('OceanP2P Test', () => {
  let node1: OceanP2P
  let node2: OceanP2P
  let config1: OceanNodeConfig
  let config2: OceanNodeConfig
  let peerId1: string
  let peerId2: string
  const mDNSInterval: number = 1

  const envOverrides = buildEnvOverrideConfig(
    [
      ENVIRONMENT_VARIABLES.PRIVATE_KEY,
      ENVIRONMENT_VARIABLES.NODE1_PRIVATE_KEY,
      ENVIRONMENT_VARIABLES.NODE2_PRIVATE_KEY
    ],
    [
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
      '0xcb345bd2b11264d523ddaf383094e2675c420a17511c3102a53817f13474a7ff',
      '0x3634cc4a3d2694a1186a7ce545f149e022eea103cc254d18d08675104bb4b5ac'
    ]
  )
  before(async () => {
    await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
  })

  it('Start instance of OceanP2P node1', async () => {
    process.env.PRIVATE_KEY = process.env.NODE1_PRIVATE_KEY
    config1 = await getConfiguration(true)
    config1.p2pConfig.ipV4BindTcpPort = 0
    config1.p2pConfig.ipV6BindTcpPort = 0
    config1.p2pConfig.ipV4BindWsPort = 0
    config1.p2pConfig.ipV4BindWssPort = 0
    config1.p2pConfig.ipV6BindWsPort = 0
    // we don't need bootstrap nodes, we rely on Multicast DNS
    config1.p2pConfig.mDNSInterval = mDNSInterval * 1e3
    config1.p2pConfig.bootstrapNodes = []
    // enable private IP
    config1.p2pConfig.announcePrivateIp = true
    config1.p2pConfig.filterAnnouncedAddresses = ['172.15.0.0/24']
    const keyManager = new KeyManager(config1)
    node1 = new OceanP2P(config1, keyManager)
    peerId1 = keyManager.getPeerIdString()
    await node1.start()
    assert(node1, 'Failed to create P2P Node instance')
  })
  it('Start instance of OceanP2P node2', async () => {
    process.env.PRIVATE_KEY = process.env.NODE2_PRIVATE_KEY
    config2 = await getConfiguration(true)
    config2.p2pConfig.ipV4BindTcpPort = 0
    config2.p2pConfig.ipV4BindWsPort = 0
    config2.p2pConfig.ipV4BindWssPort = 0
    config2.p2pConfig.ipV6BindTcpPort = 0
    config2.p2pConfig.ipV6BindWsPort = 0
    // we don't need bootstrap nodes, we rely on Multicast DNS
    config2.p2pConfig.mDNSInterval = mDNSInterval * 1e3
    config2.p2pConfig.bootstrapNodes = []
    // enable private IP
    config2.p2pConfig.announcePrivateIp = true
    config2.p2pConfig.filterAnnouncedAddresses = ['172.15.0.0/24'] // allow nodes to see each other locally for tests
    const keyManager2 = new KeyManager(config2)
    node2 = new OceanP2P(config2, keyManager2)
    peerId2 = keyManager2.getPeerIdString()
    await node2.start()
    assert(node2, 'Failed to create P2P Node instance')
  })
  it('Start check peerID of each node', () => {
    assert(peerId1 === node1._libp2p.peerId.toString(), 'Peer missmatch for node1')
    assert(peerId2 === node2._libp2p.peerId.toString(), 'Peer missmatch for node2')
  })
  delay(mDNSInterval * 1e3 * 2)
  it('Start check if nodes are connected', async () => {
    const allPeers1 = await node1.getAllPeerStore()
    const peers1 = allPeers1.map((a: any) => a.id.toString())
    assert(peers1.includes(peerId2), 'Node2 not found in node1 peer list')
    const allPeers2 = await node2.getAllPeerStore()
    const peers2 = allPeers2.map((a: any) => a.id.toString())
    assert(peers2.includes(peerId1), 'Node1 not found in node2 peer list')
  })
  it('Start check if nodes are connected with pubsub', async () => {
    let peers = await node1.getOceanPeers()
    assert(peers.includes(peerId2), 'Node2 not found in node1 peer list')
    peers = await node2.getOceanPeers()
    assert(peers.includes(peerId1), 'Node1 not found in node2 peer list')
  })

  after(() => {
    tearDownEnvironment(envOverrides)
  })
})

describe('OceanP2P Test without DB_URL set', () => {
  it('Start instance of OceanP2P without a database URL', async () => {
    // NO need to mess more with process.env variables
    const config = await getConfiguration(true)
    config.dbConfig.url = ''
    config.dbConfig.dbType = null
    // assert(config.dbConfig.url === '', 'DB URL should not be set')
    const keyManager = new KeyManager(config)
    const p2pNode = new OceanP2P(config, keyManager)
    assert(p2pNode, 'Failed to create P2P Node instance')
    assert(config.p2pConfig, 'Failed to get P2P Node config')
    // This is not testing P2P Node at all, just checking configuration
    // assert(config.dbConfig.url === '', 'P2P Node config should not have DB URL set')
    // assert(config.hasIndexer === false, 'P2P Node should not have indexer enabled')
  })
})
