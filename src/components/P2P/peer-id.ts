
import {createFromPrivKey} from '@libp2p/peer-id-factory'
import {keys} from '@libp2p/crypto'
import {hexStringToByteArray} from '../../utils'
import { P2P_CONSOLE_LOGGER } from './index'
import { GENERIC_EMOJIS } from '../../utils/logging/Logger'

/* Retusn NodeId, PublicKey, PrivateKey */
export async function getPeerIdFromPrivateKey(){
    let key
    //const privateKey = '0xbee525d70c715bee6ca15ea5113e544d13cc1bb2817e07113d0af7755ddb6391'
    //key = new keys.supportedKeys.secp256k1.Secp256k1PrivateKey(hexStringToByteArray(privateKey.slice(2)))
    //console.log(key)

    key=await keys.generateKeyPair('secp256k1')
    
    


    //console.log(key)
    const id = await createFromPrivKey(key)
    //console.log('Starting node with peerID:'+id)
    P2P_CONSOLE_LOGGER.logMessageWithEmoji('Starting node with peerID:'+id, true, GENERIC_EMOJIS.EMOJI_CHECK_MARK);

    return {
        peerId:id,
        publicKey: (key as any)._publicKey,
        privateKey: (key as any)._key
    }
}
