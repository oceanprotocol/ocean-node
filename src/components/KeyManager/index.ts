import type { PeerId } from '@libp2p/interface'
import { Signer, Wallet, FallbackProvider } from 'ethers'
import { IKeyProvider } from '../../@types/KeyManager.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RawPrivateKeyProvider } from './providers/RawPrivateKeyProvider.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import { Readable } from 'stream'
/**
 * Factory function to create the appropriate key provider based on configuration.
 * Provider is initialized in its constructor.
 *
 * @param config - Key provider configuration
 * @returns An initialized key provider instance
 */
export function createKeyProvider(config: OceanNodeConfig): IKeyProvider {
  let provider: IKeyProvider

  switch (config.keys.type) {
    case 'raw':
      provider = new RawPrivateKeyProvider(config)
      break

    case 'gcp-kms':
      throw new Error('GCP KMS provider not yet implemented')

    default:
      throw new Error(`Unsupported key provider type: ${config.keys.type}`)
  }

  return provider
}

/**
 * KeyManager centralizes all key management for OceanNode.
 * Provides access to peerId, libp2p keys, EVM address, and EVM signers.
 * Uses a key provider abstraction to support multiple key sources (raw, GCP KMS, etc.)
 */
export class KeyManager {
  private keyProvider: IKeyProvider
  private evmSigners: Map<string, Signer> // Cache: "chainId-providerKey" -> Signer

  constructor(config: OceanNodeConfig) {
    // Determine and create the appropriate key provider based on config.keys.type

    this.keyProvider = createKeyProvider(config)
    this.evmSigners = new Map<string, Signer>()
  }

  /**
   * Get the libp2p PeerId
   */
  getPeerId(): PeerId {
    return this.keyProvider.getPeerId()
  }

  /**
   * Get the libp2p private key
   */
  getLibp2pPrivateKey(): any {
    return this.keyProvider.getLibp2pPrivateKey()
  }

  /**
   * Get the libp2p public key as Uint8Array
   */
  getPublicKey(): Uint8Array {
    return this.keyProvider.getPublicKey()
  }

  /**
   * Get the Ethereum Wallet
   */
  getEthWallet(): Wallet {
    return this.keyProvider.getEthWallet()
  }

  /**
   * Get the Ethereum address
   */
  getEthAddress(): string {
    return this.keyProvider.getEthAddress()
  }

  /**
   * Get the key provider instance
   */
  getKeyProvider(): IKeyProvider {
    return this.keyProvider
  }

  /**
   * Get or create an EVM signer for a specific chainId and provider.
   * Signers are cached per chainId
   *
   * @param provider - The JSON-RPC provider to connect the signer to
   * @returns An ethers Signer instance
   */
  async getEvmSigner(provider: FallbackProvider, chainId?: number): Promise<Signer> {
    // Create a cache key based on chainId and provider URL
    // TO DO
    if (!chainId) {
      const { chainId: networkChainId } = await provider.getNetwork()
      chainId = Number(networkChainId)
    }

    const cacheKey = `${chainId}`

    // Check if we have a cached signer
    if (this.evmSigners.has(cacheKey)) {
      let cachedSigner = this.evmSigners.get(cacheKey)

      // If the provider changed, reconnect the signer
      if (cachedSigner.provider !== provider) {
        cachedSigner = (cachedSigner as Wallet).connect(provider)
        this.evmSigners.set(cacheKey, cachedSigner)
      }

      return cachedSigner
    }

    // Create new signer from private key bytes
    const privateKeyBytes = this.keyProvider.getRawPrivateKeyBytes()
    const privateKeyHex = Buffer.from(privateKeyBytes).toString('hex')
    const signer = new Wallet(privateKeyHex, provider)

    // Cache the signer
    this.evmSigners.set(cacheKey, signer)

    return signer
  }

  /**
   * Clear all cached EVM signers.
   * Useful for testing or key rotation scenarios.
   */
  clearEvmSignerCache(): void {
    this.evmSigners.clear()
  }

  /**
   * Get the peerId as a string (for compatibility with existing code)
   */
  getPeerIdString(): string {
    return this.keyProvider.getPeerId().toString()
  }

  /**
   * This method encrypts data according to a given algorithm using node keys
   * @param data data to encrypt
   * @param algorithm encryption algorithm AES or ECIES
   */
  async encrypt(data: Uint8Array, algorithm: EncryptMethod): Promise<Buffer> {
    return await this.keyProvider.encrypt(data, algorithm)
  }

  /**
   * This method decrypts data according to a given algorithm using node keys
   * @param data data to decrypt
   * @param algorithm decryption algorithm AES or ECIES
   */
  async decrypt(data: Uint8Array, algorithm: EncryptMethod): Promise<Buffer> {
    return await this.keyProvider.decrypt(data, algorithm)
  }

  /**
   * Encrypts a stream according to a given algorithm using node keys
   * @param inputStream - Readable stream to encrypt
   * @param algorithm - Encryption algorithm AES or ECIES
   * @returns Readable stream with encrypted data
   */
  encryptStream(inputStream: Readable, algorithm: EncryptMethod): Readable {
    return this.keyProvider.encryptStream(inputStream, algorithm)
  }

  /**
   * Decrypts a stream according to a given algorithm using node keys
   * @param inputStream - Readable stream to decrypt
   * @param algorithm - Decryption algorithm AES or ECIES
   * @returns Readable stream with decrypted data
   */
  decryptStream(inputStream: Readable, algorithm: EncryptMethod): Readable {
    return this.keyProvider.decryptStream(inputStream, algorithm)
  }

  /**
   * Decrypts using ethCrypto.decryptWithPrivateKey
   * @param key
   * @param encryptedObject
   * @returns Decrypted data
   */
  async ethCryptoDecryptWithPrivateKey(encryptedObject: any): Promise<any> {
    return await this.keyProvider.ethCryptoDecryptWithPrivateKey(encryptedObject)
  }

  /**
   * Signs message using ethers wallet.signMessage
   * @param message - Message to sign
   * @returns Signature
   */
  async signMessage(message: string): Promise<string> {
    return await this.keyProvider.signMessage(message)
  }

  /**
   * Cleanup resources (delegates to key provider if it has cleanup method)
   */
  async cleanup(): Promise<void> {
    if (this.keyProvider.cleanup) {
      await this.keyProvider.cleanup()
    }
    this.clearEvmSignerCache()
  }
}
