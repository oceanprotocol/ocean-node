import axios from 'axios'
import fs from 'fs'

import crypto from 'crypto'
import * as ethCrypto from 'eth-crypto'

import * as Digest from 'multiformats/hashes/digest'
import { identity } from 'multiformats/hashes/identity'
import { base58btc } from 'multiformats/bases/base58'
// import { Wallet, ethers } from 'ethers'

import pkg from 'secp256k1'
import { PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { DownloadURLCommand } from '../../@types/commands.js'

// Replace with any other file, works with a local path or URL
// '/var/log/syslog'
// See tests/unit/storage.test.ts for more examples, including IPFS and Arweave
const EXAMPLE_FILE = {
  type: 'url',
  url: 'https://ia800909.us.archive.org/13/items/CC_1917_04_16_TheCure/CC_1917_04_16_TheCure_512kb.mp4',
  method: 'get'
}

// AES encryption
const FILE_ENCRYPTION_ALGORITHM = 'aes-256-cbc'
const { publicKeyConvert } = pkg
// Decrypt the file after receiving it encrypted?
const DECRYPT_AFTER_RECEIVING_FILE = true

// ########################################
/**           README/HOWTO
 *
 * How to run these examples:
 * Open a terminal and setup node A (export port and private key) - Node A terminal
 * Open a second terminal and setup node B (export port and private key) - Node B terminal
 * Open a third terminal - this Client script
 * 1) npm run start on terminal A
 * 2) npm run start on terminal B
 * 3) npm run client
 * OBS: when making changes on the client or nodes, we always need to stop them, rebuild npm run build and restart them
 * Have fun!
 */
// ########################################
type P2PNode = {
  node_id: string
  port: number
}

// Examples; take the node's private key from your local configuration
// and take the node public key (not needed) from the getP2pPeer API (node details)
// take the port from your local configuration as well
const nodeA: P2PNode = {
  node_id: '16Uiu2HAkuYfgjXoGcSSLSpRPD6XtUgV71t5RqmTmcqdbmrWY9MJo',
  port: 8000
}

const nodeB: P2PNode = {
  node_id: '16Uiu2HAmQU8YmsACkFjkaFqEECLN3Csu6JgoU3hw9EsPmk7i9TFL',
  port: 8001
}

type PeerDetails = {
  nodeId: string
  publicKey: string
  valid: boolean
}

type FileSecrets = {
  privateKey: string // the private key used to decrypt the file
  initVector: string // the initialization vector
  encryptedKeyAndIV: string // the encrypted private key and iv, used for encrypting the file on Node side, as JSON string
}
// receive the node public key from the peer details, already validated before
/**
 *
 * @param nodePublicKey the node public key
 * @param nodeBPrivateKey the node private key
 * @returns
 */
async function createKeyPairForFileEncryption(
  nodePublicKey: string
): Promise<FileSecrets> {
  // We could also use Wallet variant
  //  let wallet = ethers.Wallet.createRandom();

  //  console.log('wallet private: ', wallet.privateKey);
  //  console.log('wallet public: ', wallet.publicKey)
  //  console.log('wallet address: ', wallet.address)

  const pair = ethCrypto.createIdentity()
  console.log('private key:', pair.privateKey)
  console.log('public key:', pair.publicKey)
  console.log('address:', pair.address)

  const keyForAESFileEncryption = crypto.randomBytes(32)
  const initializationVector = crypto.randomBytes(16)
  console.log('keyForAESFileEncryption:', keyForAESFileEncryption.toString('hex'))

  console.log('initializationVector:', initializationVector.toString('hex'))

  // Symmetric key generation, for file encryption
  const keySecrets = {
    key: keyForAESFileEncryption.toString('hex'),
    iv: initializationVector.toString('hex')
  }

  const { privateKey } = pair // '0x3634cc4a3d2694a1186a7ce545f149e022eea103cc254d18d08675104bb4b5ac'
  const secretMessage = JSON.stringify(keySecrets) // '92ecf27434c6140a5bdc6d62d972d5348e50aa6646db3a09e30ef4acc8616bef'

  console.log('Secret message JSON (before encryption): ' + secretMessage)

  const signature = ethCrypto.sign(privateKey, ethCrypto.hash.keccak256(secretMessage))
  const payload = {
    message: secretMessage,
    signature
  }

  console.log('signature: ', signature)
  console.log('payload: ', payload)

  const encryptedPayload = await ethCrypto.encryptWithPublicKey(
    nodePublicKey, // by encrypting with target Node publicKey, only target Node can decrypt the payload with his privateKey
    JSON.stringify(payload) // we have to stringify the payload before we can encrypt it
  )

  // we convert the object into a smaller string-representation
  const encryptedAESKeyAndIV = ethCrypto.cipher.stringify(encryptedPayload)

  console.log('encrypted string/key:', encryptedAESKeyAndIV)

  // we parse the string into the object again
  // const encryptedObject = ethCrypto.cipher.parse(encryptedAESKeyAndIV)

  // const decrypted = await ethCrypto.decryptWithPrivateKey(nodePrivateKey, encryptedObject)
  // const decryptedPayload = JSON.parse(decrypted)

  // // check signature
  // const senderAddress = ethCrypto.recover(
  //   decryptedPayload.signature,
  //   ethCrypto.hash.keccak256(decryptedPayload.message)
  // )

  // console.log('Got message from ' + senderAddress + ': ' + decryptedPayload.message)

  return {
    privateKey: keySecrets.key, // we need to pass it here because we're generating the key and IV inside the function
    initVector: keySecrets.iv, // same
    encryptedKeyAndIV: encryptedAESKeyAndIV
  }
}
/**
 * Decrypt the file stream
 * @param inputStream input stream to decrypt
 * @param outputStream output stream to write to
 * @param usePadding use padding?
 * @param privateKey the key to use
 * @param initVect  the initialization vector
 * @returns true if successful
 */
function decryptFileStream(
  inputStream: any,
  outputStream: any,
  privateKey: string,
  initVect: string
): Promise<boolean> {
  const decipher = crypto
    .createDecipheriv(
      FILE_ENCRYPTION_ALGORITHM,
      Buffer.from(privateKey, 'hex'),
      Buffer.from(initVect, 'hex')
    )
    .setAutoPadding(true)

  // To see what is going on uncomment below
  // decipher.on("data", chunk => {
  //    // console.log("Decrypting a file chunk of size: ", chunk.length)
  // })

  console.log('Decrypting key: ', privateKey)
  console.log('Decrypting IV: ', initVect)

  return new Promise((resolve, reject) => {
    // input => decryption => output
    inputStream.pipe(decipher).pipe(outputStream)

    inputStream.on('end', () => {
      resolve(true)
    })

    inputStream.on('error', (err: any) => {
      reject(err)
    })
  })
}

function testEchoCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    axios({
      method: 'POST',
      url: 'http://127.0.0.1:8000/directCommand',
      responseType: 'stream',
      data: {
        command: 'echo',
        // "node": "16Uiu2HAmQU8YmsACkFjkaFqEECLN3Csu6JgoU3hw9EsPmk7i9TFL",
        // "16Uiu2HAmQU8YmsACkFjkaFqEECLN3Csu6JgoU3hw9EsPmk7i9TFL",//"16Uiu2HAkuYfgjXoGcSSLSpRPD6XtUgV71t5RqmTmcqdbmrWY9MJo",
        url: 'http://example.com'
      }
    })
      .then(function (response: any) {
        console.log('Got response from server...', response.status)
        resolve(response.status === 200 ? 'OK' : 'NOK')
      })
      .catch((err: any) => {
        console.error('Error downloading....', err)
        reject(err)
      })
  })
}

function testDownloadCommand(
  exampleId: number, // this is just to append to file name for testing purposes
  nodeHttpPort: number,
  nodeId?: string,
  fileSecrets?: FileSecrets
): Promise<string> {
  const payload: DownloadURLCommand = {
    // node: '16Uiu2HAmQU8YmsACkFjkaFqEECLN3Csu6JgoU3hw9EsPmk7i9TFL', // IF not present use own node
    // own node A is: "16Uiu2HAkuYfgjXoGcSSLSpRPD6XtUgV71t5RqmTmcqdbmrWY9MJo",
    // other node B is: 16Uiu2HAmQU8YmsACkFjkaFqEECLN3Csu6JgoU3hw9EsPmk7i9TFL
    fileObject: EXAMPLE_FILE, // http://example.com'
    command: PROTOCOL_COMMANDS.DOWNLOAD_URL
    // "aes_encrypted_key": encryptedAESKeyAndIV
  }

  const useEncryption = fileSecrets && fileSecrets.encryptedKeyAndIV

  if (useEncryption) {
    payload.aes_encrypted_key = fileSecrets.encryptedKeyAndIV
  }
  if (nodeId) {
    payload.node = nodeId
  }

  return new Promise((resolve, reject) => {
    axios({
      method: 'POST',
      url: `http://127.0.0.1:${nodeHttpPort}/directCommand`,
      responseType: 'stream',
      data: payload
    })
      .then(function (response: any) {
        // console.log('Got response from server...', response.data)

        const fileOutput = './dist/helpers/scripts/output/received_out_'
        let suffix = '' + exampleId
        if (useEncryption) {
          suffix = suffix + (DECRYPT_AFTER_RECEIVING_FILE ? '.decoded' : '.encoded')
        }

        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const out = fs.createWriteStream(fileOutput + suffix)

        if (useEncryption && DECRYPT_AFTER_RECEIVING_FILE) {
          // decrypt the stream and store it decrypted already
          // if we want to store it encrypted just do as bellow:
          // response.data.pipe(fileOutput)
          decryptFileStream(
            response.data,
            out,
            fileSecrets.privateKey,
            fileSecrets.initVector
          )
            .then(() => {
              console.log('File decoded successfully locally!')
              console.log('File download complete')
              resolve(fileOutput)
            })
            .catch((err) => {
              console.log('Error decrypting the file: ', err)
            })
        } else {
          // response.data.on('data', function (chunk: any) {
          //     console.log('Got chunk: ', chunk);
          // });

          out.on('close', function () {
            console.log('Stream Ended! Saved file to path: ', fileOutput)
            // will decode the file now
            resolve(fileOutput)
          })

          // just write the file output
          response.data.pipe(out)
        }
      })
      .catch((err: any) => {
        console.error('Error downloading....', err)
        reject(err)
      })
  })
}

async function getPeerDetails(url: string, nodeId: string): Promise<PeerDetails> {
  const response = await axios.get(url, {
    params: {
      peerId: nodeId
    },
    headers: {
      Accept: 'text/json'
    }
  })

  const data = await response.data
  console.log('Got data from server:', data)
  // get the PeerDetails
  const details: PeerDetails = {
    nodeId: data.id,
    publicKey: data.publicKey,
    valid: false
  }

  // get public key
  const hexString: string = details.publicKey
  // convert it to byte array
  const publicKeyBytes: Uint8Array = Uint8Array.from(Buffer.from(hexString, 'hex'))

  // same hash that is done on peers to get a node identifier (they strip 1st byte)
  const multihash: any = await Digest.create(identity.code, publicKeyBytes)
  const generatedNodeId: string = base58btc.encode(multihash.bytes).slice(1)
  console.log('generatedNodeId', generatedNodeId)

  // confirm that this public key originated this nodeId
  const isNodeValid = generatedNodeId === details.nodeId

  console.log('isNodeValid:', isNodeValid)

  // update details info with the verification outcome
  details.valid = isNodeValid

  // console.log('Got PeerDetails:', details)

  return details
}

async function testEncryptionFlow(
  exampleId: number,
  nodeHttpPort: number,
  targetNodeId: string
): Promise<void> {
  // get the peer details and validate them to check if public key matches nodeId

  const url = `http://127.0.0.1:${nodeHttpPort}/getP2pPeer`
  console.log('url ', url)
  console.log('target id ', targetNodeId)
  const peerDetails = await getPeerDetails(
    `http://127.0.0.1:${nodeHttpPort}/getP2pPeer`,
    targetNodeId
  )
  console.log('Got Peer details:', peerDetails)
  if (peerDetails.valid) {
    const compressedPublicKey = peerDetails.publicKey
    console.log('Compressed public key:', compressedPublicKey)
    const hexArray: Uint8Array = Uint8Array.from(Buffer.from(compressedPublicKey, 'hex'))
    // console.log('hexArray:', hexArray)
    // console.log('hexArray sliced:', Buffer.from(hexArray.slice(4)).toString('hex'))
    const decompressedKeyArray: Uint8Array = publicKeyConvert(hexArray.slice(4), false)
    const decompressedPublicKey = Buffer.from(decompressedKeyArray).toString('hex')
    console.log('Decompressed public key:', decompressedPublicKey)

    // This DOES NOT WORK!!
    // const decompressedPublicKeyWithEthers = ethers.utils.computePublicKey(
    //   hexArray.slice(4),
    //   true
    // )
    // console.log(
    //   'decompressed public key with ethers:',
    //   Buffer.from(decompressedPublicKeyWithEthers).toString('hex')
    // )
    // get the AES key and IV encrypted with node public key
    const secrets: FileSecrets =
      await createKeyPairForFileEncryption(decompressedPublicKey)

    console.log('Will download now: ')
    console.log('exampleId: ', exampleId)
    console.log('nodeHttpPort: ', nodeHttpPort)
    console.log('targetNodeId: ', targetNodeId)

    // send command to Node
    await testDownloadCommand(exampleId, nodeHttpPort, targetNodeId, secrets)
  }
}

const status = await testEchoCommand()
console.log('Echo command status: ', status)

// In the following examples we always connect to Node A HTTP interface.
// Client = this script
// nodeA = The node we are connecting to via HTTP
// nodeB = The node that will be reached via P2P from nodeA

// On the 1s case Node A can serve the file directly to the client
// On 2nd case Node A will act as a proxy betweeen Node B and the Client

// ################# example 1 ####################
// Ex: 1 - Request directly to Node A
// Still goes to the same validation and encryption processes, the only difference is that Node A can serve directly to Client
await testEncryptionFlow(1, nodeA.port, nodeA.node_id)
// ################################################

// ################# example 2 ####################
// Ex: 2 - Request file from Node B, via Node A
// The file will be encrypted on node B, using the AES key/IV randomly generated on client
// Client get the peer detaisl and validates the node id agains the public key of the node
// Client encrypts the AES key and IV with node public key, and sends the HTTP request
// Node A forwards the request to Node B, Node B decrypts the AES key and IV with his private key, and encrypts the file
// Node B streams encrypted file to Node A, Node A CANNOT decrypt anything and forwards the request to the initial Client
await testEncryptionFlow(2, nodeA.port, nodeB.node_id)
// ################################################

// ################ example 3 #####################
// On the following example we swap the node roles
// Example 3 (swap nodes)
// We connect to Node B via HTTP and try to get a file from node A, instead
await testEncryptionFlow(3, nodeB.port, nodeA.node_id)
// ###############################################

// ################# example 4 ####################
// Example 4 - Same as example 1) above but without encryption
await testDownloadCommand(4, nodeA.port, nodeA.node_id)
// ################################################
