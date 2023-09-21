import diff from 'hyperdiff'

//const diff = require("hyperdiff")
//  const diff = diffx as any
import EventEmitter from 'events'
import clone from 'lodash.clonedeep'
import Connection from './connection'
import { encoding } from './connection'
import * as directConnection from './direct-connection-handler'
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

import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'


import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { createLibp2p } from 'libp2p'
import { identifyService} from 'libp2p/identify'
import { autoNATService} from 'libp2p/autonat'

import { kadDHT, } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'

import {getPeerIdFromPrivateKey} from './peer-id'

import {cidFromRawString} from '../../utils'

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
  private _handleMessage: any
  private _interval: NodeJS.Timeout
  private _idx: number
  constructor () {
    super()
  }
  async start(options:any=null){
    const topic = 'oceanprotocol'
    
    this._libp2p = await this.createNode()
    
    this._topic = topic
    this._options = Object.assign({}, clone(DEFAULT_OPTIONS), clone(options))
    this._peers = []
    this._connections = {}
    this._protocol='/ocean/nodes/1.0.0'
    this._handleDirectMessage = this._handleDirectMessage.bind(this)
    this._handleMessage = this._onMessage.bind(this)
    
    this._interval = setInterval(
      this._pollPeers.bind(this),
      this._options.pollInterval
    )
    directConnection.handle(this._libp2p,this._protocol)
    directConnection.emitter.on(this._topic, this._handleDirectMessage)
    
    
    
    this._idx = index++
    
    //await this.advertiseProviderAddress()
    
  
    
  

  
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
    const dh = kadDHT({
      // this is necessary because this node is not connected to the public network
      // it can be removed if, for example bootstrappers are configured
      allowQueryWithZeroPeers: true,
      clientMode: false, //this should be true for edge devices
      kBucketSize:20


    })
    const node = await createLibp2p({
      addresses: {
        listen: [
          '/ip4/0.0.0.0/tcp/0',
          '/ip4/0.0.0.0/tcp/0/ws',
        ]
      },
      peerId: NodeKey.peerId,
      transports: [
        webSockets(),
        tcp()
      ],
      streamMuxers: [ 
       yamux(),mplex()
      ],
      connectionEncryption: [
        //noise(),
        plaintext()
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
        autoNat: autoNATService(),
        pubsub: 
          gossipsub({ 
          allowPublishToZeroPeers: true,
          emitSelf: false,
          canRelayMessage: true,
        }),
        
        dht: dh,
      },
      connectionManager: {
        maxParallelDials: 150, // 150 total parallel multiaddr dials
        dialTimeout: 10e3, // 10 second dial timeout per peer dial


        
      },
      //nat: {
      //  enabled: true,
      //  description: `ipfs@${os.hostname()}`
      //}
  
    })
    const x=await node.start()
    console.log(x)
    
    return node
    }
    catch(e){
      console.log("Unable to create node")
      console.log(e)
    }
  }

  async startListners(){
    
    
    this._libp2p.addEventListener('peer:connect', (evt:any) => {
      if(evt){
        const peerId = evt.detail
        console.log('Connection established to:', peerId.toString()) // Emitted when a peer has been found
        try{
          this._libp2p.services.pubsub.connect(peerId.toString())
        }
        catch(e){
          console.log("Failed to connect pubsub")
        }
      }
      else{
        console.log("Null evt ")
      }
      
      
  
    })
    
    this._libp2p.addEventListener('peer:disconnect', (evt:any) => {
      const peerId = evt.detail
      console.log('Connection closed to:', peerId.toString()) // Emitted when a peer has been found
    })
    
    this._libp2p.addEventListener('peer:discovery', (evt:any) => {
      const peerInfo = evt.detail
  
      console.log('Discovered:', peerInfo.id.toString())
      
      try{
        //this._libp2p.services.pubsub.connect(peerInfo.id.toString())
        this._libp2p.services.dht.connect(peerInfo.id.toString())
      }
      catch(e){
        console.log("Failed to connect pubsub")
      }
    })
    
    this._libp2p.services.pubsub.addEventListener('peer joined', (evt:any) => {
      console.log('New peer joined us:', evt)
      
      
    })
    
    this._libp2p.services.pubsub.addEventListener('subscription-change', (evt:any) => {
      console.log('subscription-change:', evt.detail)
    })
    
    //this._libp2p.services.pubsub.on('peer joined', (peer:any) => {
    //  console.log('New peer joined us:', peer)
    //})
    //this._libp2p.services.pubsub.addEventListener('peer left', (evt:any) => {
      //console.log('Peer left...', evt)
    //})
    //this._libp2p.services.pubsub.on('peer left', (peer:any) => {
      //console.log('Peer left...', peer)
    //})
    this._libp2p.services.pubsub.addEventListener('message', (message:any) => {
      
      if(message.detail.topic === this._topic){
        console.log('Received broadcast msg...', message.detail)
      //  console.log("Sending back 'who are you' to "+message.detail.from.toString())
      //  this.sendTo(message.detail.from.toString(),'Who are you?',null)
      }
    })
    //this._libp2p.services.pubsub.on('message', (message:any) => {
    //  console.log('Received broadcast msg...', message)
    //  console.log("Sending back 'who are you' to "+message.from.toString())
    //  this.sendTo(message.from,'Who are you?',null)
    //})

    this._libp2p.services.pubsub.subscribe(this._topic)
    this._libp2p.services.pubsub.addEventListener('message', this._handleMessage)
    
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

  async leave () {
    clearInterval(this._interval)
    Object.keys(this._connections).forEach((peer) => {
      this._connections[peer].stop()
    })
    directConnection.emitter.removeListener(this._topic, this._handleDirectMessage)
    // directConnection.unhandle(this._libp2p)
    await this._libp2p.services.pubsub.unsubscribe(this._topic)
    this._libp2p.services.pubsub.removeEventListener('message', this._handleMessage)
  }

  async broadcast (_message:any) {
    console.log("Broadcasting")
    console.log(_message)
    const message = encoding(_message)
    await this._libp2p.services.pubsub.publish(this._topic, message)
  }

  async sendTo (peerName:string, message:any,sink:any) {
    console.log("Sending to "+peerName)
    console.log(message)
    let peer:PeerId
    try{
      peer=peerIdFromString(peerName)
      
    }
    catch(e){
      console.log(e)
      throw("Invalud peer")
    }
    let conn = this._connections[peerName]
    if (!conn) {
      conn = new Connection(peer, this._libp2p, this._protocol)
      conn.on('error', (err:any) => this.emit('error', err))
      this._connections[peerName] = conn

      conn.once('disconnect', () => {
        delete this._connections[peerName]
        this._peers = this._peers.filter((p) => p.toString() !== peer.toString())
        this.emit('peer left', peer)
      })
    }

    // We should use the same sequence number generation as js-libp2p-floosub does:
    // const seqno = Uint8Array.from(utils.randomSeqno())

    // Until we figure out a good way to bring in the js-libp2p-floosub's randomSeqno
    // generator, let's use 0 as the sequence number for all private messages
    const seqno = 0n

    const msg = {
      to: peer,
      from: this._libp2p.peerId.toString(),
      data: uint8ArrayToString(uint8ArrayFromString(message), 'hex'),
      seqno: seqno.toString(),
      topic: this._topic
    }
    //console.log("Pushing new msg")
    //console.log(msg)
    conn.push(uint8ArrayFromString(JSON.stringify(msg)))
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

  _handleDirectMessage (message:any,incomingStream:any) {
    if (message.to.toString() !== this._libp2p.peerId.toString()) {
      return
    }

    if (message.topic === this._topic) {
      const m = Object.assign({}, message)
      delete m.to
      //this.emit('message', m)
      console.log("Received direct protocol message....")
      console.log(m)
    }
  }

  async advertiseDid(did:string){
    console.log("Advertising "+did)
    try{
      
      const x=this._peers.length
      if(x>0){
        const cid=await cidFromRawString(did)
        const x=await this._libp2p.contentRouting.provide(cid)
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
