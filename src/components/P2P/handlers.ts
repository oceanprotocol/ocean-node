export * from './handleBroadcasts'
export * from './handleProtocolCommands'



export function handlePeerConnect(details:any){
    if(details){
        const peerId = details.detail
        //console.log('Connection established to:', peerId.toString()) // Emitted when a peer has been found
        /*
        try{
          this._libp2p.services.pubsub.connect(peerId.toString())
        }
        catch(e){
          console.log(e)
          console.log("Failed to connect pubsub")
        }
        */
      }
      //else{
      //  console.log("Null evt ")
      //}
}

export function handlePeerDisconnect(details:any){
    const peerId = details.detail
      //console.log('Connection closed to:', peerId.toString()) // Emitted when a peer has been found
}
    
export function handlePeerDiscovery(details:any){
      const peerInfo = details.detail
      //console.log('Discovered:', peerInfo.id.toString())
      
      /*
      try{
        //this._libp2p.services.pubsub.connect(peerInfo.id.toString())
        this._libp2p.services.dht.connect(peerInfo.id.toString())
      }
      catch(e){
        console.log(e)
        console.log("Failed to connect pubsub")
      }
      */   
}

export function handlePeerJoined(details:any){
    console.log('New peer joined us:', details)
}

export function handleSubscriptionCHange(details:any){
    //console.log('subscription-change:', details.detail)
}