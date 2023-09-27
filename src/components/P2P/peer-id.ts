
import {createFromPrivKey} from '@libp2p/peer-id-factory'
import {keys} from '@libp2p/crypto'
import {hexStringToByteArray} from '../../utils'


/* Retusn NodeId, PublicKey, PrivateKey */
export async function getPeerIdFromPrivateKey(){
    let key
    //const privateKey = '0xbee525d70c715bee6ca15ea5113e544d13cc1bb2817e07113d0af7755ddb6391'
    //key = new keys.supportedKeys.secp256k1.Secp256k1PrivateKey(hexStringToByteArray(privateKey.slice(2)))
    //console.log(key)

    //key=await keys.generateKeyPair('secp256k1')
    key=await keys.generateKeyPair('RSA')
    


    console.log(key)
    const id = await createFromPrivKey(key)
    console.log('Starting node with peerID:'+id)

    return {
        peerId:id,
        publicKey: (key as any)._publicKey,
        privateKey: (key as any)._key
    }
}
