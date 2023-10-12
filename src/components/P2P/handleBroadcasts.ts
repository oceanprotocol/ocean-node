export function handleBroadcasts(topic:string, message:any) {
    // can only register one handler for the protocol

    if(message.detail.topic === topic){
      console.log('Received broadcast msg...', message.detail)
    }
    else{
      //console.log('Got some relays...', message.detail)
    }
    
  }