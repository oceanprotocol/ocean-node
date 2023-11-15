import diff from 'hyperdiff'

import { P2PCommandResponse } from '../../@types/index'
// const diff = require("hyperdiff")
//  const diff = diffx as any
import EventEmitter from 'node:events'
import clone from 'lodash.clonedeep'

import {
  handleBroadcasts,
  handlePeerConnect,
  handlePeerDiscovery,
  handlePeerDisconnect,
  handlePeerJoined,
  handlePeerLeft,
  handleSubscriptionCHange,
  handleProtocolCommands,
  handleDirectProtocolCommand
} from './handlers.js'

// import { encoding } from './connection'
// import * as directConnection from './direct-connection-handler'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { bootstrap } from '@libp2p/bootstrap'
import { noise } from '@chainsafe/libp2p-noise'
import { plaintext } from 'libp2p/insecure'
import { mdns } from '@libp2p/mdns'
import { mplex } from '@libp2p/mplex'
import { yamux } from '@chainsafe/libp2p-yamux'
import { PeerId } from '@libp2p/interface/peer-id'
import { peerIdFromString } from '@libp2p/peer-id'
import { pipe } from 'it-pipe'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'

import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { createLibp2p } from 'libp2p'
import { identifyService } from 'libp2p/identify'
import { autoNATService } from 'libp2p/autonat'
import { uPnPNATService } from 'libp2p/upnp-nat'

import { kadDHT } from '@libp2p/kad-dht'
import type { PubSub } from '@libp2p/interface/pubsub'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'

import { cidFromRawString } from '../../utils/index.js'
import { Stream, Transform } from 'stream'
import { Database } from '../database'
import { OceanNodeConfig } from '../../@types/OceanNode'

import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'

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
  private _handleMessage: any
  private _interval: NodeJS.Timeout
  private _idx: number
  private db: Database
  private _config: OceanNodeConfig
  constructor(db: Database, config: OceanNodeConfig) {
    super()
    this.db = db
    this._config = config
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

  async createNode(config: OceanNodeConfig) {
    const bootstrapers = [
      // '/ip4/127.0.0.12/tcp/49100/p2p/12D3KooWLktGvbzuDK7gv1kS4pq6DNWxmxEREKVtBEhVFQmDNni7'
      '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
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
        uPnPNAT: uPnPNATService({
          description: 'my-node',
          ttl: 7200,
          keepAlive: true
        }),
        autoNat: autoNATService(),

        transports: [webSockets(), tcp()],
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
            topics: ['oceanprotocoldiscovery']
          }),
          mdns({
            interval: config.p2pConfig.mDNSInterval
          })
        ],
        services: {
          identify: identifyService(),
          pubsub: gossipsub({
            allowPublishToZeroPeers: true,
            emitSelf: false,
            canRelayMessage: true,
            enabled: true
          }),
          dht: kadDHT({
            // this is necessary because this node is not connected to the public network
            // it can be removed if, for example bootstrappers are configured
            allowQueryWithZeroPeers: true,
            maxInboundStreams: config.p2pConfig.dhtMaxInboundStreams,
            maxOutboundStreams: config.p2pConfig.dhtMaxOutboundStreams,

            clientMode: false, // this should be true for edge devices
            kBucketSize: 20
            // randomWalk: {
            //  enabled: true,            // Allows to disable discovery (enabled by default)
            //  interval: 300e3,
            //  timeout: 10e3
            // }
          })
        },
        connectionManager: {
          maxParallelDials: config.p2pConfig.connectionsMaxParallelDials, // 150 total parallel multiaddr dials
          dialTimeout: config.p2pConfig.connectionsDialTimeout // 10 second dial timeout per peer dial
        },
        nat: {
          enabled: true,
          description: `ocean@node`
        }

        // relay: {
        // enabled: true, // Allows you to dial and accept relayed connections. Does not make you a relay.
        // hop: {
        //  enabled: true // Allows you to be a relay for other peers
        // }
        // }
      }

      const node = await createLibp2p(options)
      const x = await node.start()
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
      return node
    } catch (e) {
      console.log('Unable to create node')
      console.log(e)
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
    console.log('Broadcasting')
    console.log(_message)
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
    let peer
    try {
      peerId = peerIdFromString(peerName)
      peer = await this._libp2p.peerStore.get(peerId)
    } catch (e) {
      P2P_CONSOLE_LOGGER.logMessageWithEmoji(
        'Invalid peer (for id): ' + peerId,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEl_ERROR
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
    console.log('Advertising ' + did)
    try {
      const x = this._peers.length
      if (x > 0) {
        const cid = await cidFromRawString(did)
        const x = await this._libp2p.contentRouting.provide(cid)
        console.log(x)
      }
    } catch (e) {
      console.log(e)
    }
    // console.log(CID.toString())
  }

  async getProvidersForDid(did: string) {
    console.log('Fetching providers for ' + did)
    const cid = await cidFromRawString(did)
    const peersFound = []
    try {
      const f = this._libp2p.contentRouting.findProviders(cid, { queryFuncTimeout: 5000 })
      for await (const value of f) {
        peersFound.push(value)
      }
    } catch (e) {
      console.error(e)
    }
    return peersFound
  }

  /**
   * Is the message intended for this peer or we need to connect to another one?
   * @param targetPeerID  the target node id
   * @returns true if the message is intended for this peer, false otherwise
   */
  isTargetPeerSelf(targetPeerID: string): boolean {
    return targetPeerID === this._config.keys.peerId.toString()
  }
}

function encoding(message: any) {
  if (!(message instanceof Uint8Array)) {
    return uint8ArrayFromString(message)
  }

  return message
}
