import type { PeerId } from '@libp2p/interface'
import { Wallet } from 'ethers'
import { EncryptMethod } from './fileObject.js'
import { Readable } from 'stream'
/**
 * Key provider types supported by KeyManager
 */

export type KeyProviderType = 'raw' | 'gcp-kms'
/**
 * Base interface for key providers.
 * Each key provider implementation must implement this interface.
 * Initialization happens in the constructor.
 */
export interface IKeyProvider {
  /**
   * Get the type of this key provider
   */
  getType(): string

  /**
   * Get the libp2p PeerId
   */
  getPeerId(): PeerId

  /**
   * Get the libp2p private key
   */
  getLibp2pPrivateKey(): any // libp2p PrivateKey type

  /**
   * Get the libp2p public key as Uint8Array
   */
  getPublicKey(): Uint8Array

  /**
   * Get the Ethereum address derived from the private key
   */
  getEthAddress(): string
  /**
   * Get the Ethereum Wallet derived from the private key
   */
  getEthWallet(): Wallet

  /**
   * Get the raw private key bytes for EVM signer creation.
   * This is used to create ethers Wallet instances.
   */
  getRawPrivateKeyBytes(): Uint8Array

  /**
   * Encrypts data according to a given algorithm
   * @param data data to encrypt
   * @param algorithm encryption algorithm AES or ECIES
   */
  encrypt(data: Uint8Array, algorithm: EncryptMethod): Promise<Buffer>

  /**
   * Decrypts data according to a given algorithm using node keys
   * @param data data to decrypt
   * @param algorithm decryption algorithm AES or ECIES
   */
  decrypt(data: Uint8Array, algorithm: EncryptMethod): Promise<Buffer>
  /**
   * Encrypts a stream according to a given algorithm using node keys
   * @param inputStream - Readable stream to encrypt
   * @param algorithm - Encryption algorithm AES or ECIES
   * @returns Readable stream with encrypted data
   */
  encryptStream(inputStream: Readable, algorithm: EncryptMethod): Readable
  /**
   * Decrypts a stream according to a given algorithm using node keys
   * @param inputStream - Readable stream to decrypt
   * @param algorithm - Decryption algorithm AES or ECIES
   * @returns Readable stream with decrypted data
   */
  decryptStream(inputStream: Readable, algorithm: EncryptMethod): Readable
  /**
   * Decrypts using ethCrypto.decryptWithPrivateKey
   * @param encryptedObject
   * @returns Decrypted data
   */
  ethCryptoDecryptWithPrivateKey(encryptedObject: any): Promise<any>
  /**
   * Signs message using ethers wallet.signMessage
   * @param message - Message to sign
   * @returns Signature
   */
  signMessage(message: string): Promise<string>
  /**
   * Cleanup resources if needed (e.g., close connections)
   */
  cleanup?(): Promise<void>
}
