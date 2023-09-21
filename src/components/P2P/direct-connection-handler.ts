import EventEmitter from 'events'
import { pipe } from 'it-pipe'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'


export const emitter = new EventEmitter()

export function handle (libp2p:any,protocol:string) {
  // can only register one handler for the protocol
  try{
    libp2p.handle(protocol, handler)
  }
  catch(err){
    if (err.code !== 'ERR_PROTOCOL_HANDLER_ALREADY_REGISTERED') {
      console.error(err) // eslint-disable-line no-console
    }
  }
}

export function unhandle (libp2p:any,protocol:string) {
  libp2p.unhandle(protocol, handler)
}

function handler (what:any) {
  //console.log("Starting handler")
  //console.log(what)
  const connection:any=what.connection
  const stream:any=what.stream
  
  const peerId = connection.remotePeer.toString()
  //console.log("prepare pipe ")
  pipe(
    stream,
    async function (source) {
      for await (const message of source) {
        let msg
        const converted=uint8ArrayToString(message.bufs[0]) 
          
        try {
          
          msg = JSON.parse(converted)
        } catch (err) {
          emitter.emit('warning', err.message)
          continue // early
        }

        if (peerId !== msg.from.toString()) {
          emitter.emit('warning', 'no peerid match ' + msg.from)
          continue // early
        }

        msg.data = uint8ArrayFromString(msg.data, 'hex')
        msg.seqno = BigInt(msg.seqno)
        emitter.emit(msg.topic, msg,stream)
      }
    }
  )
}
