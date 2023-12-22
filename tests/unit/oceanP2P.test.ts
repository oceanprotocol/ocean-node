import { assert } from 'chai'
import { getConfig } from '../../utils/config.js'
import { OceanP2P } from '../../components/P2P/index.js'
import { delay } from '../integration/testUtils.js'

describe('OceanP2P Test', () => {
  let node1: OceanP2P
  let node2: OceanP2P
  let config1: any
  let config2: any
  it('Start instance of OceanP2P node1', async () => {
    process.env.PRIVATE_KEY = process.env.NODE1_PRIVATE_KEY
    config1 = await getConfig()
    config1.p2pConfig.ipV4BindTcpPort = 0
    config1.p2pConfig.bootstrapNodes = []
    node1 = new OceanP2P(null, config1)
    await node1.start()
    assert(node1, 'Failed to create P2P Node instance')
  })
  it('Start instance of OceanP2P node2', async () => {
    process.env.PRIVATE_KEY = process.env.NODE2_PRIVATE_KEY
    config2 = await getConfig()
    config2.p2pConfig.ipV4BindTcpPort = 0
    config2.p2pConfig.bootstrapNodes = []
    node2 = new OceanP2P(null, config2)
    await node2.start()
    assert(node2, 'Failed to create P2P Node instance')
  })
  it('Start check peerID of each node', async () => {
    assert(
      config1.keys.peerId.toString() === node1._libp2p.peerId.toString(),
      'Peer missmatch for node1'
    )
    assert(
      config2.keys.peerId.toString() === node2._libp2p.peerId.toString(),
      'Peer missmatch for node2'
    )
  })
  delay(1000)
  it('Start check if nodes are connected', async () => {
    const allPeers1 = await node1.getAllPeerStore()
    const peers1 = allPeers1.map((a: any) => a.id.toString())
    assert(
      peers1.includes(config2.keys.peerId.toString()),
      'Node2 not found in node1 peer list'
    )
    const allPeers2 = await node2.getAllPeerStore()
    const peers2 = allPeers2.map((a: any) => a.id.toString())
    assert(
      peers2.includes(config1.keys.peerId.toString()),
      'Node1 not found in node2 peer list'
    )
  })
  it('Start check if nodes are connected with pubsub', async () => {
    let peers = await node1.getPeers()
    const peers1 = peers.map((p) => p.toString())
    assert(
      peers1.includes(config2.keys.peerId.toString()),
      'Node2 not found in node1 peer list'
    )
    peers = await node2.getPeers()
    const peers2 = peers.map((p) => p.toString())
    assert(
      peers2.includes(config1.keys.peerId.toString()),
      'Node1 not found in node2 peer list'
    )
  })
})
