// import diff from 'hyperdiff'
import { P2PCommandResponse, TypesenseSearchResponse } from '../../@types/index'
import EventEmitter from 'node:events'
import clone from 'lodash.clonedeep'

import {
  // handlePeerConnect,
  // handlePeerDiscovery,
  // handlePeerDisconnect,
  handleProtocolCommands
} from './handlers.js'

import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'

import { bootstrap } from '@libp2p/bootstrap'
import { noise } from '@chainsafe/libp2p-noise'
import { mdns } from '@libp2p/mdns'
import { yamux } from '@chainsafe/libp2p-yamux'
import { peerIdFromString } from '@libp2p/peer-id'
import { pipe } from 'it-pipe'
// import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'

import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { createLibp2p, Libp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { autoNAT } from '@libp2p/autonat'
import { uPnPNAT } from '@libp2p/upnp-nat'
import { ping } from '@libp2p/ping'
import { dcutr } from '@libp2p/dcutr'
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht'
// import { gossipsub } from '@chainsafe/libp2p-gossipsub'

import { EVENTS, cidFromRawString } from '../../utils/index.js'
import { Transform } from 'stream'
import { Database } from '../database'
import { OceanNodeConfig, FindDDOResponse } from '../../@types/OceanNode'
// eslint-disable-next-line camelcase
import is_ip_private from 'private-ip'
import ip from 'ip'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { INDEXER_DDO_EVENT_EMITTER } from '../Indexer/index.js'
import { P2P_LOGGER } from '../../utils/logging/common.js'
import { CoreHandlersRegistry } from '../core/handler/coreHandlersRegistry'
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr'
// import { getIPv4, getIPv6 } from '../../utils/ip.js'

const DEFAULT_OPTIONS = {
  pollInterval: 1000
}
// we might want this configurable
export const CACHE_TTL = 1000 * 60 * 5 // 5 minutes
type DDOCache = {
  // when last updated cache
  updated: number
  dht: Map<string, FindDDOResponse>
}

// republish any ddos we are providing to the network every 4 hours
// (we can put smaller interval for testing purposes)
const REPUBLISH_INTERVAL_HOURS = 1000 * 60 * 60 * 4 // 4 hours

let index = 0

export class OceanP2P extends EventEmitter {
  _libp2p: any
  _topic: string
  _options: any
  _peers: any[]
  _connections: {}
  _protocol: string
  _publicAddress: string
  _publicKey: Uint8Array
  _privateKey: Uint8Array
  _analyzeRemoteResponse: Transform
  _pendingAdvertise: string[] = []
  private _ddoDHT: DDOCache
  private _handleMessage: any
  private _interval: NodeJS.Timeout
  private _upnp_interval: NodeJS.Timeout
  private _ip_discovery_interval: NodeJS.Timeout
  private _idx: number
  private readonly db: Database
  private readonly _config: OceanNodeConfig
  private coreHandlers: CoreHandlersRegistry
  constructor(config: OceanNodeConfig, db?: Database) {
    super()
    this._config = config
    this.db = db
    this._ddoDHT = {
      updated: new Date().getTime(),
      dht: new Map<string, FindDDOResponse>()
    }
  }

  setCoreHandlers(coreHandlers: CoreHandlersRegistry) {
    if (!this.coreHandlers) {
      this.coreHandlers = coreHandlers
    }
  }

  getCoreHandlers() {
    return this.coreHandlers
  }

  async start(options: any = null) {
    this._topic = 'oceanprotocol'
    this._libp2p = await this.createNode(this._config)

    this._libp2p.addEventListener('peer:connect', (evt: any) => {
      this.handlePeerConnect(evt)
    })
    this._libp2p.addEventListener('peer:disconnect', (evt: any) => {
      this.handlePeerDisconnect(evt)
    })
    this._libp2p.addEventListener('peer:discovery', (details: any) => {
      this.handlePeerDiscovery(details)
    })

    this._options = Object.assign({}, clone(DEFAULT_OPTIONS), clone(options))
    this._peers = []
    this._connections = {}
    this._protocol = '/ocean/nodes/1.0.0'

    // this._interval = setInterval(this._pollPeers.bind(this), this._options.pollInterval)
    this._libp2p.handle(this._protocol, handleProtocolCommands.bind(this))

    setInterval(this.republishStoredDDOS.bind(this), REPUBLISH_INTERVAL_HOURS)

    this._idx = index++

    this._analyzeRemoteResponse = new Transform({
      transform(chunk, encoding, callback) {
        callback(null, chunk.toString().toUpperCase())
      }
    })
    // listen for indexer events and advertise did
    INDEXER_DDO_EVENT_EMITTER.addListener(EVENTS.METADATA_CREATED, (did) => {
      P2P_LOGGER.info(`Listened "${EVENTS.METADATA_CREATED}"`)
      this.advertiseDid(did)
    })
  }

  handlePeerConnect(details: any) {
    if (details) {
      const peerId = details.detail
      P2P_LOGGER.debug('Connection established to:' + peerId.toString()) // Emitted when a peer has been found
      // try {
      //   this._libp2p.services.pubsub.connect(peerId.toString())
      // } catch (e) {}
    }
  }

  handlePeerDisconnect(details: any) {
    const peerId = details.detail
    P2P_LOGGER.debug('Connection closed to:' + peerId.toString()) // Emitted when a peer has been found
  }

  async handlePeerDiscovery(details: any) {
    try {
      const peerInfo = details.detail
      // P2P_LOGGER.debug('Discovered new peer:' + peerInfo.id.toString())
      if (peerInfo.multiaddrs) {
        await this._libp2p.peerStore.save(peerInfo.id, {
          multiaddrs: peerInfo.multiaddrs
        })
        await this._libp2p.peerStore.patch(peerInfo.id, {
          multiaddrs: peerInfo.multiaddrs
        })
      }
    } catch (e) {
      // no panic if it failed
      // console.error(e)
    }
  }

  handlePeerJoined(details: any) {
    P2P_LOGGER.debug('New peer joined us:' + details)
  }

  handlePeerLeft(details: any) {
    P2P_LOGGER.debug('Peer left us:' + details)
  }

  handlePeerMessage(details: any) {
    P2P_LOGGER.debug('peer joined us:' + details)
  }

  handleSubscriptionCHange(details: any) {
    P2P_LOGGER.debug('subscription-change:' + details.detail)
  }

  shouldAnnounce(addr: any) {
    try {
      const maddr = multiaddr(addr)
      // always filter loopback
      if (ip.isLoopback(maddr.nodeAddress().address)) {
        // disabled logs because of flooding
        // P2P_LOGGER.debug('Deny announcement of loopback ' + maddr.nodeAddress().address)
        return false
      }
      // check filters
      for (const filter of this._config.p2pConfig.filterAnnouncedAddresses) {
        if (ip.cidrSubnet(filter).contains(maddr.nodeAddress().address)) {
          // disabled logs because of flooding
          // P2P_LOGGER.debug(
          //  'Deny announcement of filtered ' +
          //    maddr.nodeAddress().address +
          //    '(belongs to ' +
          //    filter +
          //    ')'
          // )
          return false
        }
      }
      if (
        this._config.p2pConfig.announcePrivateIp === false &&
        (is_ip_private(maddr.nodeAddress().address) ||
          ip.isPrivate(maddr.nodeAddress().address))
      ) {
        // disabled logs because of flooding
        // P2P_LOGGER.debug(
        //  'Deny announcement of private address ' + maddr.nodeAddress().address
        // )
        return false
      } else {
        // disabled logs because of flooding
        // P2P_LOGGER.debug('Allow announcement of ' + maddr.nodeAddress().address)
        return true
      }
    } catch (e) {
      // we reach this part when having circuit relay. this is fine
      return true
    }
  }

  async createNode(config: OceanNodeConfig): Promise<Libp2p | null> {
    try {
      this._publicAddress = config.keys.peerId.toString()
      this._publicKey = config.keys.publicKey
      this._privateKey = config.keys.privateKey
      /** @type {import('libp2p').Libp2pOptions} */
      // start with some default, overwrite based on config later
      const bindInterfaces = []
      if (config.p2pConfig.enableIPV4) {
        P2P_LOGGER.info('Binding P2P sockets to IPV4')
        bindInterfaces.push(
          `/ip4/${config.p2pConfig.ipV4BindAddress}/tcp/${config.p2pConfig.ipV4BindTcpPort}`
        )
        bindInterfaces.push(
          `/ip4/${config.p2pConfig.ipV4BindAddress}/tcp/${config.p2pConfig.ipV4BindWsPort}/ws`
        )
      }
      if (config.p2pConfig.enableIPV6) {
        P2P_LOGGER.info('Binding P2P sockets to IPV6')
        bindInterfaces.push(
          `/ip6/${config.p2pConfig.ipV6BindAddress}/tcp/${config.p2pConfig.ipV6BindTcpPort}`
        )
        bindInterfaces.push(
          `/ip6/${config.p2pConfig.ipV6BindAddress}/tcp/${config.p2pConfig.ipV6BindWsPort}/ws`
        )
      }
      let addresses = {}
      if (
        config.p2pConfig.announceAddresses &&
        config.p2pConfig.announceAddresses.length > 0
      ) {
        addresses = {
          listen: bindInterfaces,
          announceFilter: (multiaddrs: any[]) =>
            multiaddrs.filter((m) => this.shouldAnnounce(m)),
          announce: config.p2pConfig.announceAddresses
        }
      } else {
        addresses = {
          listen: bindInterfaces,
          announceFilter: (multiaddrs: any[]) =>
            multiaddrs.filter((m) => this.shouldAnnounce(m))
        }
      }
      let servicesConfig = {
        identify: identify(),
        /*
        pubsub: gossipsub({
          fallbackToFloodsub: false,
          batchPublish: false,
          allowPublishToZeroTopicPeers: true,
          asyncValidation: false,
          // messageProcessingConcurrency: 5,
          seenTTL: 10 * 1000,
          runOnTransientConnection: true,
          doPX: doPx,
          // canRelayMessage: true,
          // enabled: true
          allowedTopics: ['oceanprotocol._peer-discovery._p2p._pubsub', 'oceanprotocol']
        }), */
        dht: kadDHT({
          // this is necessary because this node is not connected to the public network
          // it can be removed if, for example bootstrappers are configured
          allowQueryWithZeroPeers: true,
          maxInboundStreams: config.p2pConfig.dhtMaxInboundStreams,
          maxOutboundStreams: config.p2pConfig.dhtMaxOutboundStreams,

          clientMode: false,
          kBucketSize: 20,
          protocol: '/ocean/nodes/1.0.0/kad/1.0.0',
          peerInfoMapper: passthroughMapper
          // protocolPrefix: '/ocean/nodes/1.0.0'
          // randomWalk: {
          //  enabled: true,            // Allows to disable discovery (enabled by default)
          //  interval: 300e3,
          //  timeout: 10e3
          // }
        }),
        ping: ping(),
        dcutr: dcutr()
      }
      // eslint-disable-next-line no-constant-condition, no-self-compare
      if (config.p2pConfig.enableCircuitRelayServer) {
        P2P_LOGGER.info('Enabling Circuit Relay Server')
        servicesConfig = { ...servicesConfig, ...{ circuitRelay: circuitRelayServer() } }
      }
      // eslint-disable-next-line no-constant-condition, no-self-compare
      if (config.p2pConfig.upnp) {
        P2P_LOGGER.info('Enabling UPnp discovery')
        servicesConfig = { ...servicesConfig, ...{ upnpNAT: uPnPNAT() } }
      }
      // eslint-disable-next-line no-constant-condition, no-self-compare
      if (config.p2pConfig.autoNat) {
        P2P_LOGGER.info('Enabling AutoNat service')
        servicesConfig = {
          ...servicesConfig,
          ...{ autoNAT: autoNAT({ maxInboundStreams: 20, maxOutboundStreams: 20 }) }
        }
      }

      let transports = []
      P2P_LOGGER.info('Enabling P2P Transports: websockets, tcp, circuitRelay')
      transports = [
        webSockets(),
        tcp(),
        circuitRelayTransport({
          discoverRelays: config.p2pConfig.circuitRelays
        })
      ]

      let options = {
        addresses,
        peerId: config.keys.peerId,
        transports,
        streamMuxers: [yamux()],
        connectionEncryption: [
          noise()
          // plaintext()
        ],
        services: servicesConfig,
        connectionManager: {
          maxParallelDials: config.p2pConfig.connectionsMaxParallelDials, // 150 total parallel multiaddr dials
          dialTimeout: config.p2pConfig.connectionsDialTimeout, // 10 second dial timeout per peer dial
          minConnections: config.p2pConfig.minConnections,
          maxConnections: config.p2pConfig.maxConnections,
          autoDialPeerRetryThreshold: config.p2pConfig.autoDialPeerRetryThreshold,
          autoDialConcurrency: config.p2pConfig.autoDialConcurrency,
          maxPeerAddrsToDial: config.p2pConfig.maxPeerAddrsToDial,
          autoDialInterval: config.p2pConfig.autoDialInterval
        }
      }
      if (config.p2pConfig.bootstrapNodes && config.p2pConfig.bootstrapNodes.length > 0) {
        options = {
          ...options,
          ...{
            peerDiscovery: [
              bootstrap({
                list: config.p2pConfig.bootstrapNodes,
                timeout: config.p2pConfig.bootstrapTimeout, // in ms,
                tagName: config.p2pConfig.bootstrapTagName,
                tagValue: config.p2pConfig.bootstrapTagValue,
                tagTTL: config.p2pConfig.bootstrapTTL
              }),
              mdns({
                interval: config.p2pConfig.mDNSInterval
              }) /*,
              pubsubPeerDiscovery({
                interval: config.p2pConfig.pubsubPeerDiscoveryInterval,
                topics: [
                  // 'oceanprotocoldiscovery',
                  `oceanprotocol._peer-discovery._p2p._pubsub` // It's recommended but not required to extend the global space
                  // '_peer-discovery._p2p._pubsub' // Include if you want to participate in the global space
                ],
                listenOnly: false
              }) */
            ]
          }
        }
      } else {
        // only mdns & pubsubPeerDiscovery
        options = {
          ...options,
          ...{
            peerDiscovery: [
              mdns({
                interval: config.p2pConfig.mDNSInterval
              }) /*,
              pubsubPeerDiscovery({
                interval: config.p2pConfig.pubsubPeerDiscoveryInterval,
                topics: [
                  // 'oceanprotocoldiscovery',
                  `oceanprotocol._peer-discovery._p2p._pubsub` // It's recommended but not required to extend the global space
                  // '_peer-discovery._p2p._pubsub' // Include if you want to participate in the global space
                ],
                listenOnly: false
              }) */
            ]
          }
        }
      }
      const node = await createLibp2p(options)
      await node.start()

      const upnpService = (node.services as any).upnpNAT
      if (config.p2pConfig.upnp && upnpService) {
        this._upnp_interval = setInterval(this.UPnpCron.bind(this), 3000)
      }

      if (config.p2pConfig.enableDHTServer) {
        try {
          await node.services.dht.setMode('server')
        } catch (e) {
          P2P_LOGGER.warn(`Failed to set mode server for DHT`)
        }
      }
      return node
    } catch (e) {
      P2P_LOGGER.logMessageWithEmoji(
        'Unable to create node: ' + e.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
    }
    return null
  }

  async getAllPeerStore() {
    const s = await this._libp2p.peerStore.all()
    return s
    // for await (const peer of this._libp2p.peerRouting.getClosestPeers(s[0].id.toString())) {
    //  console.log(peer.id, peer.multiaddrs)
    // }
  }

  async getNetworkingStats() {
    const ret: any = {}
    ret.binds = await this._libp2p.components.addressManager.getListenAddrs()
    ret.listen = await this._libp2p.components.transportManager.getAddrs()
    ret.observing = await this._libp2p.components.addressManager.getObservedAddrs()
    ret.announce = await this._libp2p.components.addressManager.getAnnounceAddrs()
    ret.connections = await this._libp2p.getConnections()
    return ret
  }

  async getRunningOceanPeers() {
    return await this.getOceanPeers(true, false)
  }

  async getKnownOceanPeers() {
    return await this.getOceanPeers(false, true)
  }

  async getAllOceanPeers() {
    return await this.getOceanPeers(true, true)
  }

  async getOceanPeers(running: boolean = true, known: boolean = true) {
    const peers: string[] = []
    /* if (running) {
      // get pubsub peers
      const node = <any>this._libp2p
      const newPeers = (await node.services.pubsub.getSubscribers(this._topic)).sort()
      for (const peer of newPeers.slice(0)) {
        if (!peers.includes(peer.toString)) peers.push(peer.toString())
      }
    } */
    if (known) {
      // get p2p peers and filter them by protocol
      for (const peer of await this._libp2p.peerStore.all()) {
        // if (peer && peer.protocols) {
        // for (const protocol of peer.protocols) {
        //  if (protocol === this._protocol) {
        if (!peers.includes(peer.id.toString())) peers.push(peer.id.toString())
        // }
        // }
        // }
      }
    }

    return peers
  }

  async hasPeer(peer: any) {
    const s = await this._libp2p.peerStore.all()
    return Boolean(s.find((p: any) => p.toString() === peer.toString()))
  }

  async getPeerDetails(peerName: string) {
    try {
      const peerId = peerIdFromString(peerName)
      // Example: for ID 16Uiu2HAkuYfgjXoGcSSLSpRPD6XtUgV71t5RqmTmcqdbmrWY9MJo
      // Buffer.from(this._config.keys.publicKey).toString('hex') =>         0201cabbabef1cc85218fa2d5bbadfb3425dfc091b311a33e6d9be26f6dcb94668
      // Buffer.from(peerId.publicKey).toString('hex')            => 080212210201cabbabef1cc85218fa2d5bbadfb3425dfc091b311a33e6d9be26f6dcb94668
      // 08021221 = > extra 4 bytes at the beginning, but they are important for later
      // UPDATE: no need to slice 4 bytes here, actually we need those on client side to verify the node id and perform the encryption of the keys + iv
      // See config.ts => getPeerIdFromPrivateKey()

      const pubKey = Buffer.from(peerId.publicKey).toString('hex') // no need to do .subarray(4).toString('hex')
      const peer = await this._libp2p.peerStore.get(peerId)

      // write the publicKey as well
      peer.publicKey = pubKey
      // Note: this is a 'compressed' version of the publicKey, we need to decompress it on client side (not working with bellow attempts)
      // otherwise the encryption will fail due to public key size mismatch

      // taken from '@libp2p/crypto/keys/secp256k1' decompressPublicKey (cannot import module/function)
      // const decompressedKey = secp.ProjectivePoint.fromHex(key.public.bytes).toRawBytes(false)
      // Buffer.from(decompressedKey).toString('hex')
      // in any case is not working (it crashes here)

      return peer
    } catch (e) {
      return null
    }
  }

  async getPeerMultiaddrs(
    peerName: string,
    searchPeerStore: boolean = true,
    searchDHT: boolean = true
  ): Promise<Multiaddr[]> {
    const multiaddrs: Multiaddr[] = []
    let peerId
    try {
      peerId = peerIdFromString(peerName)
    } catch (e) {
      return []
    }
    if (searchPeerStore) {
      // search peerStore
      try {
        const peerData = await this._libp2p.peerStore.get(peerId, {
          signal: AbortSignal.timeout(3000)
        })
        if (peerData) {
          for (const x of peerData.addresses) {
            multiaddrs.push(x.multiaddr)
          }
        }
      } catch (e) {
        // console.log(e)
      }
    }
    if (searchDHT) {
      try {
        const peerData = await this._libp2p.peerRouting.findPeer(peerId, {
          signal: AbortSignal.timeout(3000),
          useCache: false
        })
        if (peerData) {
          for (const index in peerData.multiaddrs) {
            multiaddrs.push(peerData.multiaddrs[index])
          }
        }
      } catch (e) {
        // console.log(e)
      }
    }

    // now we should have peer multiaddrs
    // but there is a catch
    // when dialing multiaddrs, either all of them have peerId, or none..
    // so decide which one to use
    let finalmultiaddrs: Multiaddr[] = []
    const finalmultiaddrsWithAddress: Multiaddr[] = []
    const finalmultiaddrsWithoutAddress: Multiaddr[] = []
    for (const x of multiaddrs) {
      if (x.toString().includes(peerName)) finalmultiaddrsWithAddress.push(x)
      else {
        let sd = x.toString()
        if (x.toString().includes('p2p-circuit')) {
          // because a p2p-circuit should always include peerId, if it's missing we will add it
          sd = sd + '/p2p/' + peerName
          finalmultiaddrsWithAddress.push(multiaddr(sd))
        } else {
          finalmultiaddrsWithoutAddress.push(multiaddr(sd))
        }
      }
    }
    if (finalmultiaddrsWithAddress.length > finalmultiaddrsWithoutAddress.length)
      finalmultiaddrs = finalmultiaddrsWithAddress
    else finalmultiaddrs = finalmultiaddrsWithoutAddress
    return finalmultiaddrs
  }

  async sendTo(
    peerName: string,
    message: string,
    sink: any
  ): Promise<P2PCommandResponse> {
    P2P_LOGGER.logMessage('SendTo() node ' + peerName + ' task: ' + message, true)

    const response: P2PCommandResponse = {
      status: { httpStatus: 200, error: '' },
      stream: null
    }
    let peerId: any
    try {
      peerId = peerIdFromString(peerName)
    } catch (e) {
      P2P_LOGGER.logMessageWithEmoji(
        'Invalid peer (for id): ' + peerId,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      response.status.httpStatus = 404
      response.status.error = 'Invalid peer'
      return response
    }
    const multiaddrs: Multiaddr[] = await this.getPeerMultiaddrs(peerName)
    if (multiaddrs.length < 1) {
      response.status.httpStatus = 404
      response.status.error = `Cannot find any address to dial for peer: ${peerId}`
      P2P_LOGGER.error(response.status.error)
      return response
    }

    let stream
    // dial/connect to the target node
    try {
      stream = await this._libp2p.dialProtocol(multiaddrs, this._protocol, {
        signal: AbortSignal.timeout(3000),
        priority: 100,
        runOnTransientConnection: true
      })
    } catch (e) {
      response.status.httpStatus = 404
      response.status.error = `Cannot connect to peer: ${peerId}`
      P2P_LOGGER.error(response.status.error)
      return response
    }

    if (stream) {
      response.stream = stream
      try {
        await pipe(
          // Source data
          [uint8ArrayFromString(message)],
          // Write to the stream, and pass its output to the next function
          stream,
          // this is the anayze function
          // doubler as any,
          // Sink function
          sink
        )
      } catch (err) {
        P2P_LOGGER.error(`Unable to send P2P message: ${err.message}`)
        response.status.httpStatus = 404
        response.status.error = err.message
      }
    } else {
      response.status.httpStatus = 404
      response.status.error = 'Unable to get remote P2P stream (null)'
      P2P_LOGGER.error(response.status.error)
    }

    return response
  }

  // when the target is this node
  // async sendToSelf(message: string, sink: any): Promise<P2PCommandResponse> {
  //   const response: P2PCommandResponse = {
  //     status: { httpStatus: 200, error: '' },
  //     stream: null
  //   }
  //   // direct message to self
  //   // create a writable stream
  //   // const outputStream = new Stream.Writable()
  //   response.stream = new Stream.Writable()
  //   // read from input stream to output one and move on
  //   await handleDirectProtocolCommand.call(this, message, sink)

  //   return response
  // }

  /* async _pollPeers() {
    const node = <any>this._libp2p
    const newPeers = (await node.services.pubsub.getSubscribers(this._topic)).sort()
    if (this._emitChanges(newPeers)) {
      const addedNew = newPeers.length > this._peers.length
      this._peers = newPeers

      // retry any pending stuff
      if (addedNew) {
        this._pendingAdvertise.forEach((did: string) => {
          P2P_LOGGER.info('Retry pending advertise...')
          this.advertiseDid(did)
        })
        this._pendingAdvertise = []
      }
    }
  }

  _emitChanges(newPeers: any) {
    const peers = this._peers.map((p) => p.toString())
    const newpeers = newPeers.map((x: any) => x.toString())
    const differences = diff(peers, newpeers)

    differences.added.forEach((peer: any) => this.emit('peer joined', peer))
    differences.removed.forEach((peer: any) => this.emit('peer left', peer))
    const x = differences.added.length > 0 || differences.removed.length > 0
    return x
  }
*/
  _onMessage(event: any) {
    const message = event.detail

    if (message.topic === this._topic) {
      this.emit('message', message)
    }
  }

  async advertiseDid(did: string) {
    P2P_LOGGER.logMessage('Advertising ' + did, true)
    try {
      const x = (await this.getAllOceanPeers()).length
      if (x > 0) {
        const cid = await cidFromRawString(did)
        const multiAddrs = this._libp2p.components.addressManager.getAddresses()
        // console.log('multiaddrs: ', multiAddrs)
        await this._libp2p.contentRouting.provide(cid, multiAddrs)
      } else {
        P2P_LOGGER.verbose(
          'Could not find any Ocean peers. Nobody is listening at the moment, skipping...'
        )
        // save it for retry later
        // https://github.com/libp2p/js-libp2p-kad-dht/issues/98
        if (!this._pendingAdvertise.includes(did)) {
          this._pendingAdvertise.push(did)
        }
      }
    } catch (e) {
      P2P_LOGGER.error('advertiseDid():' + e.message)
    }
  }

  async getProvidersForDid(did: string) {
    P2P_LOGGER.logMessage('Fetching providers for ' + did, true)
    const cid = await cidFromRawString(did)
    const peersFound = []
    try {
      const f = await this._libp2p.contentRouting.findProviders(cid, {
        queryFuncTimeout: 20000 // 20 seconds
        // on timeout the query ends with an abort signal => CodeError: Query aborted
      })
      for await (const value of f) {
        peersFound.push(value)
      }
    } catch (e) {
      P2P_LOGGER.error('getProvidersForDid()' + e.message)
    }
    return peersFound
  }

  // republish the ddos we have
  // related: https://github.com/libp2p/go-libp2p-kad-dht/issues/323
  async republishStoredDDOS() {
    try {
      if (!this.db) {
        P2P_LOGGER.logMessage(
          `republishStoredDDOS() attempt aborted because there is no database!`,
          true
        )
        return
      }
      const db = this.db.ddo
      const searchParameters = {
        q: '*'
      }

      const result: TypesenseSearchResponse[] = await db.search(searchParameters)
      if (result && result.length > 0 && result[0].found) {
        P2P_LOGGER.logMessage(`Will republish cid for ${result[0].found} documents`, true)
        result[0].hits.forEach((hit: any) => {
          const ddo = hit.document
          this.advertiseDid(ddo.id)
          // populate hash table if not exists
          // (even if no peers are listening, it still goes to the pending publish table)
          if (!this._ddoDHT.dht.has(ddo.id)) {
            this.cacheDDO(ddo)
          }
          // todo check stuff like purgatory
        })
        // update time
        this._ddoDHT.updated = new Date().getTime()
      } else {
        P2P_LOGGER.logMessage('There is nothing to republish, skipping...', true)
      }
    } catch (err) {
      P2P_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Caught "${err.message}" on republishStoredDDOS()`,
        true
      )
    }
  }

  // cache a ddos object
  cacheDDO(ddo: any) {
    this._ddoDHT.dht.set(ddo.id, {
      id: ddo.id,
      lastUpdateTx: ddo.event ? ddo.event.tx : '', // some missing event? probably just bad test data
      lastUpdateTime: ddo.metadata.updated,
      provider: this.getPeerId()
    })
  }

  /**
   * Is the message intended for this peer or we need to connect to another one?
   * @param targetPeerID  the target node id
   * @returns true if the message is intended for this peer, false otherwise
   */
  isTargetPeerSelf(targetPeerID: string): boolean {
    return targetPeerID === this.getPeerId()
  }

  getPeerId(): string {
    return this._config.keys.peerId.toString()
  }

  getDDOCache(): DDOCache {
    return this._ddoDHT
  }

  /**
   * Goes through some dddo list list and tries to store and avertise
   * @param list the initial list
   * @param node the node
   * @returns  boolean from counter
   */
  // eslint-disable-next-line require-await
  async storeAndAdvertiseDDOS(list: any[]): Promise<boolean> {
    if (!this.db) {
      P2P_LOGGER.logMessage(
        `storeAndAdvertiseDDOS() attempt aborted because there is no database!`,
        true
      )
      return false
    }
    try {
      let count = 0
      P2P_LOGGER.logMessage(
        `Trying to store and advertise ${list.length} initial DDOS`,
        true
      )
      const db = this.db.ddo
      list.forEach(async (ddo: any) => {
        // if already added before, create() will return null, but still advertise it
        try {
          await db.create(ddo)
          await this.advertiseDid(ddo.id)
          // populate hash table
          this.cacheDDO(ddo)
          count++
        } catch (e) {
          P2P_LOGGER.log(
            LOG_LEVELS_STR.LEVEL_ERROR,
            `Caught "${e.message}" on storeAndAdvertiseDDOS()`,
            true
          )
        }
      })
      if (count > 0) {
        this._ddoDHT.updated = new Date().getTime()
      }
      return count === list.length
    } catch (err) {
      P2P_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Caught "${err.message}" on storeAndAdvertiseDDOS()`,
        true
      )
      return false
    }
  }

  async UPnpCron() {
    // we need to wait until we have some peers connected
    clearInterval(this._upnp_interval)
    const node = <any>this._libp2p
    // try autodiscover by using ipify.org.  This is a very long shot, but it works if you have a proper port forward
    // let haveIPv4 = false
    // let haveIPv6 = false
    // const addrs = node.components.transportManager.getAddrs()
    // for (const addr of addrs) {
    //   if (addr.toOptions().family === 4) haveIPv4 = true
    //   if (addr.toOptions().family === 6) haveIPv6 = true
    // }
    // P2P_LOGGER.info(`Doing discovery on IPv4: ` + haveIPv4 + ' , IPv6:' + haveIPv6)
    // if (
    //   node &&
    //   this._config.p2pConfig &&
    //   this._config.p2pConfig.enableIPV4 &&
    //   this._config.p2pConfig.ipV4BindTcpPort > 0 &&
    //   haveIPv4
    // ) {
    //   const ipV4 = await getIPv4()

    //   if (ipV4) {
    //     P2P_LOGGER.info(`Looks like our external IPV4 address is ` + ipV4)
    //     const addressToAdd = multiaddr(
    //       '/ip4/' + ipV4 + '/tcp/' + String(this._config.p2pConfig.ipV4BindTcpPort)
    //     )
    //     const alreadyObserving = await node.components.addressManager.getObservedAddrs()
    //     if (!alreadyObserving.includes(addressToAdd)) {
    //       P2P_LOGGER.info('Adding ' + addressToAdd.toString() + ' to observed addresses')

    //       try {
    //         await node.components.addressManager.addObservedAddr(addressToAdd)
    //       } catch (e) {
    //         P2P_LOGGER.info('Failed to add')
    //       }
    //     }
    //   } else {
    //     P2P_LOGGER.info(`Cannot detect our public IPv4`)
    //   }
    // }

    // if (
    //   node &&
    //   this._config.p2pConfig &&
    //   this._config.p2pConfig.enableIPV6 &&
    //   this._config.p2pConfig.ipV6BindTcpPort > 0 &&
    //   haveIPv6
    // ) {
    //   const ipV6 = await getIPv6()

    //   if (ipV6) {
    //     P2P_LOGGER.info(`Looks like our external IPV6 address is ` + ipV6)
    //     const addressToAdd = multiaddr(
    //       '/ip6/' + ipV6 + '/tcp/' + String(this._config.p2pConfig.ipV6BindTcpPort)
    //     )
    //     const alreadyObserving = await node.components.addressManager.getObservedAddrs()
    //     if (!alreadyObserving.includes(addressToAdd)) {
    //       P2P_LOGGER.info('Adding ' + addressToAdd.toString() + ' to observed addresses')

    //       try {
    //         await node.components.addressManager.addObservedAddr(addressToAdd)
    //       } catch (e) {
    //         P2P_LOGGER.info('Failed to add')
    //       }
    //     }
    //   } else {
    //     P2P_LOGGER.info(`Cannot detect our public IPv6`)
    //   }
    // }

    if (node) {
      const connManager = node.components.connectionManager
      if (connManager) {
        const conns = await connManager.getConnections()
        if (conns.length > 1) {
          const upnpService = (node.services as any).upnpNAT
          if (this._config.p2pConfig.upnp && upnpService) {
            P2P_LOGGER.info('Trying to punch a hole using UPNP')
            try {
              await upnpService.mapIpAddresses()
            } catch (err) {
              P2P_LOGGER.info('Failed to configure UPNP Gateway(if you have one)')
              P2P_LOGGER.debug(err)
            }
            return
          }
        }
      }
    }
    this._upnp_interval = setInterval(this.UPnpCron.bind(this), 3000)
  }
}
