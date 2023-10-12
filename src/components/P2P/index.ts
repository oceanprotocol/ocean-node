import diff from 'hyperdiff'


import { P2PCommandResponse} from '../../@types/index'
//const diff = require("hyperdiff")
//  const diff = diffx as any
import EventEmitter from 'events'
import clone from 'lodash.clonedeep'

import { handleBroadcasts, handlePeerConnect, handlePeerDiscovery, handlePeerDisconnect,handlePeerJoined,handlePeerLeft,handleSubscriptionCHange,handleProtocolCommands } from './handlers'

//import { encoding } from './connection'
//import * as directConnection from './direct-connection-handler'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

import { bootstrap } from '@libp2p/bootstrap'
import { noise } from '@chainsafe/libp2p-noise'
import { plaintext } from 'libp2p/insecure'
import { mdns } from '@libp2p/mdns'
import  { mplex} from '@libp2p/mplex'
import { yamux } from '@chainsafe/libp2p-yamux'
import { PeerId } from '@libp2p/interface/peer-id';
import {peerIdFromString} from '@libp2p/peer-id'
import { pipe } from 'it-pipe'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'


import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { createLibp2p } from 'libp2p'
import { identifyService} from 'libp2p/identify'
import { autoNATService} from 'libp2p/autonat'
import { uPnPNATService } from 'libp2p/upnp-nat'

import { kadDHT, } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'

import {getPeerIdFromPrivateKey} from './peer-id'

import {cidFromRawString} from '../../utils'
import { Stream,Transform  } from 'stream'
import { Database } from '../database'
import { AutoDial } from 'libp2p/dist/src/connection-manager/auto-dial'

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
  private db:Database
  constructor (db:Database) {
    super()
    this.db=db
  }
  async start(options:any=null){
    this._topic = 'oceanprotocol'
    this._libp2p = await this.createNode()
    
    this._options = Object.assign({}, clone(DEFAULT_OPTIONS), clone(options))
    this._peers = []
    this._connections = {}
    this._protocol='/ocean/nodes/1.0.0'
    
    this._interval = setInterval(
      this._pollPeers.bind(this),
      this._options.pollInterval
    )
    this._libp2p.handle(this._protocol, handleProtocolCommands)
    
    
    
    this._idx = index++
    
    //await this.advertiseProviderAddress()
    
    this._analyzeRemoteResponse = new Transform({
      transform(chunk, encoding, callback) {
        callback(null, chunk.toString().toUpperCase());
      },
    });
    
  

  
  }
  async createNode(){
    const bootstrapers = [
      //'/ip4/127.0.0.12/tcp/49100/p2p/12D3KooWLktGvbzuDK7gv1kS4pq6DNWxmxEREKVtBEhVFQmDNni7'
      '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAxajnQjVM8WjWXoMbmPd7NsWhfKsPkErzpm9wGkp',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
      '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
      
    ]
    const NodeKey= await getPeerIdFromPrivateKey()
    try{
    this._publicAddress=NodeKey.peerId.toString()
    this._publicKey=NodeKey.publicKey
    this._privateKey=NodeKey.privateKey
    
    /** @type {import('libp2p').Libp2pOptions} */
    const options= {
      addresses: {
        listen: [
          '/ip4/0.0.0.0/tcp/0',
          '/ip6/::1/tcp/0',
          '/ip4/0.0.0.0/tcp/0/ws',
          '/ip6/::1/tcp/0/ws',
        ]
      },
      peerId: NodeKey.peerId,
      uPnPNAT: uPnPNATService(
        {
          description: 'my-node',
          ttl:7200,
          keepAlive:true
        }
      ),
      autoNat: autoNATService(),
      
      transports: [
        webSockets(),
        tcp()
      ],
      streamMuxers: [ 
       yamux(),mplex()
      ],
      connectionEncryption: [
        noise(),
        //plaintext()
      ],
      peerDiscovery: [
        bootstrap({
          list: bootstrapers
        }),
        pubsubPeerDiscovery({
          interval: 1000,
          topics: ['oceanprotocoldiscovery']
        }),
        mdns({
          interval: 20e3
        })
      ],
      services: {
        identify: identifyService(),
        pubsub: 
          gossipsub({ 
            allowPublishToZeroPeers: true,
            emitSelf: false,
            canRelayMessage: true,
            enabled:true
        }),
        dht: kadDHT(
          {
              // this is necessary because this node is not connected to the public network
              // it can be removed if, for example bootstrappers are configured
              allowQueryWithZeroPeers: true,
              maxInboundStreams:500,
              maxOutboundStreams:500,

              clientMode: false, //this should be true for edge devices
              kBucketSize:20,
          //randomWalk: {
          //  enabled: true,            // Allows to disable discovery (enabled by default)
          //  interval: 300e3,
          //  timeout: 10e3
          //}
          }
        )
      },
      connectionManager: {
        maxParallelDials: 150, // 150 total parallel multiaddr dials
        dialTimeout: 10e3, // 10 second dial timeout per peer dial
        
      },
      nat: {
        enabled: true,
        description: `ocean@node`
      }

      //relay: {
       // enabled: true, // Allows you to dial and accept relayed connections. Does not make you a relay.
       // hop: {
        //  enabled: true // Allows you to be a relay for other peers
       // }
      //}
    }
    const node = await createLibp2p(options)
      const x=await node.start()
      node.addEventListener('peer:connect', (evt:any) => { handlePeerConnect(evt) })
      node.addEventListener('peer:disconnect', (evt:any) => { handlePeerDisconnect(evt)})
      node.addEventListener('peer:discovery', (evt:any) => { handlePeerDiscovery(evt)})
      
      //node.services.pubsub.addEventListener(  'peer joined', (evt:any) => {handlePeerJoined(evt)})
      //node.services.pubsub.addEventListener('peer left', (evt:any) => {handlePeerLeft(evt)})
      //node.services.pubsub.addEventListener('subscription-change', (evt:any) => { handleSubscriptionCHange(evt)})
    
    //this._libp2p.services.pubsub.on('peer joined', (peer:any) => {
      //console.log('New peer joined us:', peer)
    //})
    //this._libp2p.services.pubsub.addEventListener('peer left', (evt:any) => {
      //console.log('Peer left...', evt)
    //})
    //this._libp2p.services.pubsub.on('peer left', (peer:any) => {
      //console.log('Peer left...', peer)
    //})
    node.services.pubsub.addEventListener('message', (message:any) => {handleBroadcasts(this._topic,message)})
    //this._libp2p.services.pubsub.on('message', (message:any) => {
    //  console.log('Received broadcast msg...', message)
    //  console.log("Sending back 'who are you' to "+message.from.toString())
    //  this.sendTo(message.from,'Who are you?',null)
    //})
    node.services.pubsub.subscribe(this._topic)
    node.services.pubsub.publish(this._topic,encoding("online"))
    return node
    }
    catch(e){
      console.log("Unable to create node")
      console.log(e)
    }
    return null
  }

  
  async getAllPeerStore(){
    const s=await this._libp2p.peerStore.all()
    return(s)
    //for await (const peer of this._libp2p.peerRouting.getClosestPeers(s[0].id.toString())) {
    //  console.log(peer.id, peer.multiaddrs)
    //}
  }
  getPeers () {
    return this._peers.slice(0)
  }

  hasPeer (peer:any) {
    return Boolean(this._peers.find(p => p.toString() === peer.toString()))
  }

  async broadcast (_message:any) {
    console.log("Broadcasting")
    console.log(_message)
    const message = encoding(_message)
    await this._libp2p.services.pubsub.publish(this._topic, message)
  }

  
  async getPeerDetails(peerName:string){
    try{
      const peerId=peerIdFromString(peerName)
      const peer = await this._libp2p.peerStore.get(peerId)
      return peer
    }
    catch(e){
      return(null)
    }

  }
  async sendTo (peerName:string, message:string, sink:any):Promise<P2PCommandResponse> {
    console.log("Executing on node "+peerName+" task: "+message)
    const status:P2PCommandResponse = {
      status: {httpStatus:200,error:''},
      stream: null
    }
    let peerId:PeerId
    let peer
    try{
      peerId=peerIdFromString(peerName)
      peer = await this._libp2p.peerStore.get(peerId)
    }
    catch(e){
      
      status.status.httpStatus=404
      status.status.error="Invalid peer"
      return(status)
    }
    let stream
    try{
      //stream= await this._libp2p.dialProtocol(peer, this._protocol)
      
      stream = await this._libp2p.dialProtocol(peerId, this._protocol)
      
    }
    catch(e){
      
      status.status.httpStatus=404
      status.status.error="Cannot connect to peer"
      return(status)
    }
    
    status.stream=stream
    pipe(
      // Source data
      [uint8ArrayFromString(message)],
      // Write to the stream, and pass its output to the next function
      stream,
      //this is the anayze function
      //doubler as any,
      // Sink function
      sink
    )
    return(status)
    
  }

  async _pollPeers () {
    const node=<any>this._libp2p
    const newPeers = (await node.services.pubsub.getSubscribers(this._topic)).sort()

    if (this._emitChanges(newPeers)) {
      this._peers = newPeers
    }
  }

  _emitChanges (newPeers:any) {
    const peers=this._peers.map(p =>p.toString())
    const newpeers=newPeers.map((x:any) => x.toString())
    const differences = diff(peers, newpeers)

    differences.added.forEach((peer:any) => this.emit('peer joined', peer))
    differences.removed.forEach((peer:any) => this.emit('peer left', peer))

    return differences.added.length > 0 || differences.removed.length > 0
  }

  _onMessage (event:any) {
    const message = event.detail

    if (message.topic === this._topic) {
      this.emit('message', message)
    }
  }

  async advertiseDid(did:string){
    console.log("Advertising "+did)
    try{
      
      const x=this._peers.length
      if(x>0){
        const cid=await cidFromRawString(did)
        const x=await this._libp2p.contentRouting.provide(cid)
        console.log(x)
      }
    }
    catch(e){
      console.log(e)
    }
    //console.log(CID.toString())
  }

  async getProvidersForDid(did:string) {
    console.log("Fetching providers for "+did)
    const cid=await cidFromRawString(did)
    const peersFound=[]
    try{
      const f=this._libp2p.contentRouting.findProviders(cid,{queryFuncTimeout:5000})
      for await (const value of f) {
        peersFound.push(value)
      }
    }
    catch(e){
      console.error(e)
    }
    return(peersFound)
  }
}


function encoding(message:any){
  if (!(message instanceof Uint8Array)) {
    return uint8ArrayFromString(message)
  }

  return message
}


