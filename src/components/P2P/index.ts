import diff from 'hyperdiff'
import { P2PCommandResponse } from '../../@types/index'
import EventEmitter from 'node:events'
import clone from 'lodash.clonedeep'

import {
  handleBroadcasts,
  handlePeerConnect,
  handlePeerDiscovery,
  handlePeerDisconnect,
  handleProtocolCommands,
  handleDirectProtocolCommand
} from './handlers.js'

import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'

import { bootstrap } from '@libp2p/bootstrap'
import { noise } from '@chainsafe/libp2p-noise'
import { mdns } from '@libp2p/mdns'
import { mplex } from '@libp2p/mplex'
import { yamux } from '@chainsafe/libp2p-yamux'
import { PeerId } from '@libp2p/interface/peer-id'
import { peerIdFromString } from '@libp2p/peer-id'
import { pipe } from 'it-pipe'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'

import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { createLibp2p, Libp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { autoNAT } from '@libp2p/autonat'
import { uPnPNAT } from '@libp2p/upnp-nat'
import { ping } from '@libp2p/ping'
import { dcutr } from '@libp2p/dcutr'

import { kadDHT } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'

import { EVENTS, cidFromRawString } from '../../utils/index.js'
import { Stream, Transform } from 'stream'
import { Database } from '../database'
import { OceanNodeConfig, FindDDOResponse } from '../../@types/OceanNode'

import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule,
  newCustomDBTransport,
  getLoggerLevelEmoji
} from '../../utils/logging/Logger.js'
import { INDEXER_DDO_EVENT_EMITTER } from '../Indexer'

// just use the default logger with default transports
// Bellow is just an example usage, only logging to console here
export const P2P_CONSOLE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.P2P,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

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
  private _ddoDHT: DDOCache
  private _handleMessage: any
  private _interval: NodeJS.Timeout
  private _idx: number
  private db: Database
  private _config: OceanNodeConfig
  constructor(db: Database, config: OceanNodeConfig) {
    super()
    this.db = db
    this._config = config
    const customLogTransport = newCustomDBTransport(this.db)
    P2P_CONSOLE_LOGGER.addTransport(customLogTransport)
    this._ddoDHT = {
      updated: new Date().getTime(),
      dht: new Map<string, FindDDOResponse>()
    }

    // listen for indexer events and advertise did
    INDEXER_DDO_EVENT_EMITTER.addListener(EVENTS.METADATA_CREATED, (did) => {
      P2P_CONSOLE_LOGGER.info(`Listened "${EVENTS.METADATA_CREATED}"`)
      this.advertiseDid(did)
    })
  }

  async start(options: any = null) {
    this._topic = 'oceanprotocol'
    this._libp2p = await this.createNode(this._config)

    this._options = Object.assign({}, clone(DEFAULT_OPTIONS), clone(options))
    this._peers = []
    this._connections = {}
    this._protocol = '/ocean/nodes/1.0.0'

    this._interval = setInterval(this._pollPeers.bind(this), this._options.pollInterval)
    this._libp2p.handle(this._protocol, handleProtocolCommands.bind(this))

    this._idx = index++

    // await this.advertiseProviderAddress()

    this._analyzeRemoteResponse = new Transform({
      transform(chunk, encoding, callback) {
        callback(null, chunk.toString().toUpperCase())
      }
    })
  }

  async createNode(config: OceanNodeConfig): Promise<Libp2p | null> {
    const bootstrapers = [
      '/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
      '/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
      '/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
      // '/ip4/127.0.0.12/tcp/49100/p2p/12D3KooWLktGvbzuDK7gv1kS4pq6DNWxmxEREKVtBEhVFQmDNni7'
      '/ip4/35.198.125.13/tcp/8000/p2p/16Uiu2HAmKZuuY2Lx3JiY938rJWZrYQh6kjBZCNrh3ALkodtwFRdF', // paulo
      '/ip4/34.159.64.236/tcp/8000/p2p/16Uiu2HAmAy1GcZGhzFT3cbARTmodg9c3M4EAmtBZyDgu5cSL1NPr', // jaime
      '/ip4/34.107.3.14/tcp/8000/p2p/16Uiu2HAm4DWmX56ZX2bKjvARJQZPMUZ9xsdtAfrMmd7P8czcN4UT', // maria
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
    ]
    try {
      this._publicAddress = config.keys.peerId.toString()
      this._publicKey = config.keys.publicKey
      this._privateKey = config.keys.privateKey

      /** @type {import('libp2p').Libp2pOptions} */
      // start with some default, overwrite based on config later
      const options = {
        addresses: {
          listen: [
            `/ip4/${config.p2pConfig.ipV4BindAddress}/tcp/${config.p2pConfig.ipV4BindTcpPort}`,
            `/ip4/${config.p2pConfig.ipV4BindAddress}/tcp/${config.p2pConfig.ipV4BindWsPort}/ws`,
            `/ip6/${config.p2pConfig.ipV6BindAddress}/tcp/${config.p2pConfig.ipV6BindTcpPort}`,
            `/ip6/${config.p2pConfig.ipV6BindAddress}/tcp/${config.p2pConfig.ipV6BindWsPort}/ws`
          ]
        },
        peerId: config.keys.peerId,
        transports: [webSockets(), tcp(), circuitRelayTransport()],
        streamMuxers: [yamux(), mplex()],
        connectionEncryption: [
          noise()
          // plaintext()
        ],
        peerDiscovery: [
          bootstrap({
            list: bootstrapers
          }),
          pubsubPeerDiscovery({
            interval: config.p2pConfig.pubsubPeerDiscoveryInterval,
            topics: [
              'oceanprotocoldiscovery',
              `oceanprotocol._peer-discovery._p2p._pubsub`, // It's recommended but not required to extend the global space
              '_peer-discovery._p2p._pubsub' // Include if you want to participate in the global space
            ],
            listenOnly: false
          }),
          mdns({
            interval: config.p2pConfig.mDNSInterval
          })
        ],
        services: {
          identify: identify(),
          pubsub: gossipsub({
            allowPublishToZeroPeers: true
            // canRelayMessage: true,
            // enabled: true
          }),
          dht: kadDHT({
            // this is necessary because this node is not connected to the public network
            // it can be removed if, for example bootstrappers are configured
            allowQueryWithZeroPeers: true,
            maxInboundStreams: config.p2pConfig.dhtMaxInboundStreams,
            maxOutboundStreams: config.p2pConfig.dhtMaxOutboundStreams,

            clientMode: false, // this should be true for edge devices
            kBucketSize: 20
            // protocolPrefix: '/ocean/nodes/1.0.0'
            // randomWalk: {
            //  enabled: true,            // Allows to disable discovery (enabled by default)
            //  interval: 300e3,
            //  timeout: 10e3
            // }
          }),
          autoNAT: autoNAT(),
          upnpNAT: uPnPNAT(),
          ping: ping(),
          dcutr: dcutr(),
          circuitRelay: circuitRelayServer()
        },
        connectionManager: {
          maxParallelDials: config.p2pConfig.connectionsMaxParallelDials, // 150 total parallel multiaddr dials
          dialTimeout: config.p2pConfig.connectionsDialTimeout // 10 second dial timeout per peer dial
        }
      }
      const node = await createLibp2p(options)
      await node.start()
      node.addEventListener('peer:connect', (evt: any) => {
        handlePeerConnect(evt)
      })
      node.addEventListener('peer:disconnect', (evt: any) => {
        handlePeerDisconnect(evt)
      })
      node.addEventListener('peer:discovery', (evt: any) => {
        handlePeerDiscovery(evt)
      })

      // node.services.pubsub.addEventListener(  'peer joined', (evt:any) => {handlePeerJoined(evt)})
      // node.services.pubsub.addEventListener('peer left', (evt:any) => {handlePeerLeft(evt)})
      // node.services.pubsub.addEventListener('subscription-change', (evt:any) => { handleSubscriptionCHange(evt)})

      // this._libp2p.services.pubsub.on('peer joined', (peer:any) => {
      // console.log('New peer joined us:', peer)
      // })
      // this._libp2p.services.pubsub.addEventListener('peer left', (evt:any) => {
      // console.log('Peer left...', evt)
      // })
      // this._libp2p.services.pubsub.on('peer left', (peer:any) => {
      // console.log('Peer left...', peer)
      // })
      node.services.pubsub.addEventListener('message', (message: any) => {
        handleBroadcasts(this._topic, message)
      })
      // this._libp2p.services.pubsub.on('message', (message:any) => {
      //  console.log('Received broadcast msg...', message)
      //  console.log("Sending back 'who are you' to "+message.from.toString())
      //  this.sendTo(message.from,'Who are you?',null)
      // })
      node.services.pubsub.subscribe(this._topic)
      node.services.pubsub.publish(this._topic, encoding('online'))
      // ;(node.services.upnpNAT as any).mapIpAddresses()
      ;(node.services.upnpNAT as any).mapIpAddresses().catch((err: any) => {
        // hole punching errors are non-fatal
        console.error(err)
      })

      return node
    } catch (e) {
      P2P_CONSOLE_LOGGER.logMessageWithEmoji(
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

  getPeers() {
    return this._peers.slice(0)
  }

  hasPeer(peer: any) {
    return Boolean(this._peers.find((p) => p.toString() === peer.toString()))
  }

  async broadcast(_message: any) {
    P2P_CONSOLE_LOGGER.logMessage('Broadcasting:', true)
    P2P_CONSOLE_LOGGER.logMessageWithEmoji(
      _message,
      true,
      getLoggerLevelEmoji(LOG_LEVELS_STR.LEVEL_INFO),
      LOG_LEVELS_STR.LEVEL_INFO
    )
    const message = encoding(_message)
    await this._libp2p.services.pubsub.publish(this._topic, message)
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

  async sendTo(
    peerName: string,
    message: string,
    sink: any
  ): Promise<P2PCommandResponse> {
    P2P_CONSOLE_LOGGER.logMessage('SendTo() node ' + peerName + ' task: ' + message, true)

    const status: P2PCommandResponse = {
      status: { httpStatus: 200, error: '' },
      stream: null
    }
    let peerId: PeerId
    try {
      peerId = peerIdFromString(peerName)
      await this._libp2p.peerStore.get(peerId)
    } catch (e) {
      P2P_CONSOLE_LOGGER.logMessageWithEmoji(
        'Invalid peer (for id): ' + peerId,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )
      status.status.httpStatus = 404
      status.status.error = 'Invalid peer'
      return status
    }

    let stream
    // dial/connect to the target node
    try {
      // stream= await this._libp2p.dialProtocol(peer, this._protocol)

      stream = await this._libp2p.dialProtocol(peerId, this._protocol)
    } catch (e) {
      status.status.httpStatus = 404
      status.status.error = 'Cannot connect to peer'
      return status
    }

    status.stream = stream
    pipe(
      // Source data
      [uint8ArrayFromString(message)],
      // Write to the stream, and pass its output to the next function
      stream,
      // this is the anayze function
      // doubler as any,
      // Sink function
      sink
    )
    return status
  }

  // when the target is this node
  async sendToSelf(message: string, sink: any): Promise<P2PCommandResponse> {
    const status: P2PCommandResponse = {
      status: { httpStatus: 200, error: '' },
      stream: null
    }
    // direct message to self
    // create a writable stream
    // const outputStream = new Stream.Writable()
    status.stream = new Stream.Writable()
    // read from input stream to output one and move on
    await handleDirectProtocolCommand.call(this, message, sink)

    return status
  }

  async _pollPeers() {
    const node = <any>this._libp2p
    const newPeers = (await node.services.pubsub.getSubscribers(this._topic)).sort()

    if (this._emitChanges(newPeers)) {
      this._peers = newPeers
    }
  }

  _emitChanges(newPeers: any) {
    const peers = this._peers.map((p) => p.toString())
    const newpeers = newPeers.map((x: any) => x.toString())
    const differences = diff(peers, newpeers)

    differences.added.forEach((peer: any) => this.emit('peer joined', peer))
    differences.removed.forEach((peer: any) => this.emit('peer left', peer))

    return differences.added.length > 0 || differences.removed.length > 0
  }

  _onMessage(event: any) {
    const message = event.detail

    if (message.topic === this._topic) {
      this.emit('message', message)
    }
  }

  async advertiseDid(did: string) {
    P2P_CONSOLE_LOGGER.logMessage('Advertising ' + did, true)
    try {
      const x = this._peers.length
      if (x > 0) {
        const cid = await cidFromRawString(did)
        await this._libp2p.contentRouting.provide(cid)
      }
    } catch (e) {
      P2P_CONSOLE_LOGGER.error(e)
    }
  }

  async getProvidersForDid(did: string) {
    P2P_CONSOLE_LOGGER.logMessage('Fetching providers for ' + did, true)
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
      P2P_CONSOLE_LOGGER.error(e.message)
    }
    return peersFound
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

  getDatabase(): Database {
    return this.db
  }

  getConfig(): OceanNodeConfig {
    return this._config
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
  async storeAndAdvertiseDDOS(list: any[]): Promise<boolean> {
    try {
      let count = 0
      P2P_CONSOLE_LOGGER.logMessage(
        `Trying to store and advertise ${list.length} initial DDOS`,
        true
      )
      const db = this.getDatabase().ddo
      const peerId = this.getPeerId()
      list.forEach(async (ddo: any) => {
        // if already added before, create() will return null, but still advertise it
        try {
          await db.create(ddo)
          await this.advertiseDid(ddo.id)
          // populate hash table
          this._ddoDHT.dht.set(ddo.id, {
            id: ddo.id,
            lastUpdateTx: ddo.event.tx, // check if we're getting these from the right place
            lastUpdateTime: ddo.metadata.updated,
            provider: peerId
          })
          count++
        } catch (e) {
          P2P_CONSOLE_LOGGER.log(
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
      P2P_CONSOLE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Caught "${err.message}" on storeAndAdvertiseDDOS()`,
        true
      )
      return false
    }
  }
}

function encoding(message: any) {
  if (!(message instanceof Uint8Array)) {
    return uint8ArrayFromString(message)
  }

  return message
}
