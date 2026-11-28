import type { PeerId } from '@libp2p/interface'
import { Wallet } from 'ethers'
import { EncryptMethod } from './fileObject.js'
import { Readable } from 'stream'
/**
 * Key provider types supported by KeyManager
 */

export type KeyProviderType = 'raw' | 'gcp-kms' //  'aws-kms' in future
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
   * @param key optional: for ECIES, the decryptor's public key; for AES, the symmetric key (32 bytes)
   */
  encrypt(data: Uint8Array, algorithm: EncryptMethod, key?: Uint8Array): Promise<Buffer>

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
   * @param key optional: for ECIES, the decryptor's public key; for AES, the symmetric key (32 bytes)
   * @returns Readable stream with encrypted data
   */
  encryptStream(
    inputStream: Readable,
    algorithm: EncryptMethod,
    key?: Uint8Array
  ): Readable
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
   * OJ-03: sign raw bytes with the libp2p IDENTITY key (the key the peerId commits to), using
   * libp2p's native `.sign()` (secp256k1: SHA-256 + DER), verifiable in ocean.js with
   * `@libp2p/crypto` `publicKey.verify`. This is NOT the EVM signer: under every KMS provider the
   * EVM key lives in KMS while the libp2p identity key is software-resident, so this MUST be
   * implemented as a software-local op over `getLibp2pPrivateKey().sign(...)` (free, synchronous,
   * no paid remote Sign call). Used only to answer the status identity challenge.
   * @param data - raw bytes to sign (already domain-separated by the caller)
   * @returns the libp2p signature bytes
   */
  signWithIdentityKey(data: Uint8Array): Promise<Uint8Array> | Uint8Array
  /**
   * Cleanup resources if needed (e.g., close connections)
   */
  cleanup?(): Promise<void>
}
