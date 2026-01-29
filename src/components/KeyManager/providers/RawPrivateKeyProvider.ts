import type { PeerId } from '@libp2p/interface'
import { privateKeyFromRaw } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { Wallet } from 'ethers'
import { IKeyProvider } from '../../../@types/KeyManager.js'
import { hexStringToByteArray } from '../../../utils/index.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { EncryptMethod } from '../../../@types/fileObject.js'
import { Readable, Transform } from 'stream'
import * as ethCrypto from 'eth-crypto'
import eciesjs from 'eciesjs'
import crypto from 'crypto'

/**
 * Raw private key provider.
 * Loads private key from environment variable or config.
 */
export class RawPrivateKeyProvider implements IKeyProvider {
  private peerId: PeerId
  private privateKey: any // libp2p PrivateKey type
  private publicKey: Uint8Array
  private ethWallet: Wallet
  private ethAddress: string

  constructor(config: OceanNodeConfig) {
    if (!config.keys.privateKey) {
      throw new Error('RawPrivateKeyProvider requires keys.privateKey in config')
    }

    // Initialize immediately in constructor
    const rawPrivateKey = config.keys.privateKey

    // Remove '0x' prefix if present for processing
    const privateKeyHex = rawPrivateKey.startsWith('0x')
      ? rawPrivateKey.slice(2)
      : rawPrivateKey

    // Convert hex string to bytes (hexStringToByteArray expects hex without 0x)
    const privateKeyBytes = hexStringToByteArray(privateKeyHex)

    // Create libp2p private key
    const key = privateKeyFromRaw(privateKeyBytes)

    // Derive peerId from private key
    this.peerId = peerIdFromPrivateKey(key)
    this.publicKey = key.publicKey.raw

    // Store keys
    this.privateKey = key

    // Derive Ethereum address
    // Wallet constructor accepts hex with or without 0x prefix
    // We use without 0x to match existing behavior in getPeerIdFromPrivateKey
    this.ethWallet = new Wallet(privateKeyHex)
    this.ethAddress = this.ethWallet.address
  }

  getType(): string {
    return 'raw'
  }

  getPeerId(): PeerId {
    return this.peerId
  }

  getLibp2pPrivateKey(): any {
    return this.privateKey
  }

  getPublicKey(): Uint8Array {
    return this.publicKey
  }

  getEthWallet(): Wallet {
    return this.ethWallet
  }

  getEthAddress(): string {
    return this.ethAddress
  }

  getRawPrivateKeyBytes(): Uint8Array {
    return this.privateKey.raw
  }

  /**
   * This method encrypts data according to a given algorithm using node keys
   * @param data data to encrypt
   * @param algorithm encryption algorithm AES or ECIES
   */
  // eslint-disable-next-line require-await
  async encrypt(data: Uint8Array, algorithm: EncryptMethod): Promise<Buffer> {
    let encryptedData: Buffer
    const { privateKey, publicKey } = this
    console.log('privateKey', privateKey.raw.toString('hex'))
    console.log('publicKey', publicKey.toString())
    if (algorithm === EncryptMethod.AES) {
      // use first 16 bytes of public key as an initialisation vector
      const initVector = publicKey.subarray(0, 16)
      // creates cipher object, with the given algorithm, key and initialization vector
      const cipher = crypto.createCipheriv('aes-256-cbc', privateKey.raw, initVector)
      // encoding is ignored because we are working with bytes and want to return a buffer
      encryptedData = Buffer.concat([cipher.update(data), cipher.final()])
    } else if (algorithm === EncryptMethod.ECIES) {
      const sk = new eciesjs.PrivateKey(privateKey.raw)
      // get public key from Elliptic curve
      encryptedData = eciesjs.encrypt(sk.publicKey.toHex(), data)
    }
    console.log('encryptedData', encryptedData.toString('hex'))
    return encryptedData
  }

  /**
   * This method decrypts data according to a given algorithm using node keys
   * @param data data to decrypt
   * @param algorithm decryption algorithm AES or ECIES
   */
  // eslint-disable-next-line require-await
  async decrypt(data: Uint8Array, algorithm: EncryptMethod): Promise<Buffer> {
    let decryptedData: Buffer
    const { privateKey, publicKey } = this
    console.log('privateKey', privateKey.raw.toString('hex'))
    console.log('publicKey', publicKey.toString())
    if (algorithm === EncryptMethod.AES) {
      // use first 16 bytes of public key as an initialisation vector
      const initVector = publicKey.subarray(0, 16)
      // creates decipher object, with the given algorithm, key and initialization vector

      const decipher = crypto.createDecipheriv('aes-256-cbc', privateKey.raw, initVector)

      // encoding is ignored because we are working with bytes and want to return a buffer
      decryptedData = Buffer.concat([decipher.update(data), decipher.final()])
    } else if (algorithm === EncryptMethod.ECIES) {
      const sk = new eciesjs.PrivateKey(privateKey.raw)
      decryptedData = eciesjs.decrypt(sk.secret, data)
    }
    return decryptedData
  }

  /**
   * Encrypts a stream according to a given algorithm using node keys
   * @param inputStream - Readable stream to encrypt
   * @param algorithm - Encryption algorithm AES or ECIES
   * @returns Readable stream with encrypted data
   */
  encryptStream(inputStream: Readable, algorithm: EncryptMethod): Readable {
    const { privateKey, publicKey } = this

    if (algorithm === EncryptMethod.AES) {
      // Use first 16 bytes of public key as an initialization vector
      const initVector = publicKey.subarray(0, 16)
      // Create cipher transform stream
      const cipher = crypto.createCipheriv('aes-256-cbc', privateKey.raw, initVector)

      // Pipe input stream through cipher and return the encrypted stream
      return inputStream.pipe(cipher)
    } else if (algorithm === EncryptMethod.ECIES) {
      // ECIES doesn't support streaming, so we need to collect all data first
      const chunks: Buffer[] = []
      const collector = new Transform({
        transform(chunk, encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
          callback()
        },
        flush(callback) {
          // Collect all chunks
          const data = Buffer.concat(chunks)
          // Encrypt using ECIES
          const sk = new eciesjs.PrivateKey(privateKey.raw)
          const encryptedData = eciesjs.encrypt(sk.publicKey.toHex(), data)
          // Push encrypted data as a single chunk
          this.push(Buffer.from(encryptedData))
          callback()
        }
      })

      return inputStream.pipe(collector)
    } else {
      throw new Error(`Unsupported encryption algorithm: ${algorithm}`)
    }
  }

  /**
   * Decrypts a stream according to a given algorithm using node keys
   * @param inputStream - Readable stream to decrypt
   * @param algorithm - Decryption algorithm AES or ECIES
   * @returns Readable stream with decrypted data
   */
  decryptStream(inputStream: Readable, algorithm: EncryptMethod): Readable {
    const { privateKey, publicKey } = this

    if (algorithm === EncryptMethod.AES) {
      // Use first 16 bytes of public key as an initialization vector
      const initVector = publicKey.subarray(0, 16)
      // Create decipher transform stream
      const decipher = crypto.createDecipheriv('aes-256-cbc', privateKey.raw, initVector)

      // Pipe input stream through decipher and return the decrypted stream
      return inputStream.pipe(decipher)
    } else if (algorithm === EncryptMethod.ECIES) {
      // ECIES doesn't support streaming, so we need to collect all data first
      const chunks: Buffer[] = []
      const collector = new Transform({
        transform(chunk, encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
          callback()
        },
        flush(callback) {
          // Collect all chunks
          const data = Buffer.concat(chunks)
          // Decrypt using ECIES
          const sk = new eciesjs.PrivateKey(privateKey.raw)
          const decryptedData = eciesjs.decrypt(sk.secret, data)
          // Push decrypted data as a single chunk
          this.push(Buffer.from(decryptedData))
          callback()
        }
      })

      return inputStream.pipe(collector)
    } else {
      throw new Error(`Unsupported decryption algorithm: ${algorithm}`)
    }
  }

  /**
   * Decrypts using ethCrypto.decryptWithPrivateKey
   * @param key
   * @param encryptedObject
   * @returns Decrypted data
   */
  async ethCryptoDecryptWithPrivateKey(encryptedObject: any): Promise<any> {
    const { privateKey } = this
    const encrypted = ethCrypto.cipher.parse(encryptedObject)
    // get the key from configuration
    const nodePrivateKey = Buffer.from(privateKey.raw).toString('hex')
    const decrypted = await ethCrypto.decryptWithPrivateKey(nodePrivateKey, encrypted)
    return decrypted
  }
}
