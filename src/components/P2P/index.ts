import diff from 'hyperdiff'
import { P2PCommandResponse, TypesenseSearchResponse } from '../../@types/index'
import EventEmitter from 'node:events'
import clone from 'lodash.clonedeep'

import {
  handleBroadcasts,
  handlePeerConnect,
  handlePeerDiscovery,
  handlePeerDisconnect,
  handleProtocolCommands
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
import { Transform } from 'stream'
import { Database } from '../database'
import { OceanNodeConfig, FindDDOResponse } from '../../@types/OceanNode'

import {
  GENERIC_EMOJIS,
  LOG_LEVELS_STR,
  getLoggerLevelEmoji
} from '../../utils/logging/Logger.js'
import { INDEXER_DDO_EVENT_EMITTER } from '../Indexer/index.js'
import { P2P_LOGGER } from '../../utils/logging/common.js'
import { CoreHandlersRegistry } from '../core/handler/coreHandlersRegistry'

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

    this._options = Object.assign({}, clone(DEFAULT_OPTIONS), clone(options))
    this._peers = []
    this._connections = {}
    this._protocol = '/ocean/nodes/1.0.0'

    this._interval = setInterval(this._pollPeers.bind(this), this._options.pollInterval)
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

  async createNode(config: OceanNodeConfig): Promise<Libp2p | null> {
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
            list: config.p2pConfig.bootstrapNodes
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
            kBucketSize: 20,
            protocolPrefix: '/ocean/nodes/1.0.0'
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

  getPeers() {
    return this._peers.slice(0)
  }

  hasPeer(peer: any) {
    return Boolean(this._peers.find((p) => p.toString() === peer.toString()))
  }

  async broadcast(_message: any) {
    P2P_LOGGER.logMessage('Broadcasting:', true)
    P2P_LOGGER.logMessageWithEmoji(
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
    P2P_LOGGER.logMessage('SendTo() node ' + peerName + ' task: ' + message, true)

    const response: P2PCommandResponse = {
      status: { httpStatus: 200, error: '' },
      stream: null
    }
    let peerId: PeerId
    try {
      peerId = peerIdFromString(peerName)
      await this._libp2p.peerStore.get(peerId)
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

    let stream
    // dial/connect to the target node
    try {
      // stream= await this._libp2p.dialProtocol(peer, this._protocol)

      stream = await this._libp2p.dialProtocol(peerId, this._protocol)
    } catch (e) {
      response.status.httpStatus = 404
      response.status.error = 'Cannot connect to peer'
      return response
    }

    response.stream = stream
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

  async _pollPeers() {
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

    return differences.added.length > 0 || differences.removed.length > 0
  }

  _onMessage(event: any) {
    const message = event.detail

    if (message.topic === this._topic) {
      this.emit('message', message)
    }
  }

  async advertiseDid(did: string) {
    P2P_LOGGER.logMessage('Advertising ' + did, true)
    try {
      const x = this._peers.length
      if (x > 0) {
        const cid = await cidFromRawString(did)
        const multiAddrs = this._libp2p.components.addressManager.getAddresses()
        // console.log('multiaddrs: ', multiAddrs)
        await this._libp2p.contentRouting.provide(cid, multiAddrs)
      } else {
        P2P_LOGGER.warn(
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
        q: '*',
        query_by: 'metadata.name'
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
}

function encoding(message: any) {
  if (!(message instanceof Uint8Array)) {
    return uint8ArrayFromString(message)
  }

  return message
}
