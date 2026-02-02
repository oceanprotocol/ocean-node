import { Blockchain } from '../../utils/blockchain.js'
import { KeyManager } from '../KeyManager/index.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RPCS } from '../../@types/blockchain.js'

/**
 * BlockchainRegistry manages Blockchain instances per chainId.
 * Provides lazy initialization and centralized access to blockchain connections.
 */
export class BlockchainRegistry {
  private blockchains: Map<number, Blockchain>
  private keyManager: KeyManager
  private config: OceanNodeConfig

  constructor(keyManager: KeyManager, config: OceanNodeConfig) {
    this.keyManager = keyManager
    this.config = config
    this.blockchains = new Map<number, Blockchain>()
  }

  /**
   * Get or create a Blockchain instance for the given chainId.
   * Returns null if the chainId is not supported.
   *
   * @param chainId - The chain ID to get a Blockchain instance for
   * @returns Blockchain instance or null if not supported
   */
  getBlockchain(chainId: number): Blockchain | null {
    // Check if already initialized
    if (this.blockchains.has(chainId)) {
      return this.blockchains.get(chainId)
    }

    // Check if chainId is supported
    const supportedNetworks = this.config.supportedNetworks as RPCS
    if (!supportedNetworks || !supportedNetworks[chainId.toString()]) {
      return null
    }

    // Get network configuration
    const networkConfig = supportedNetworks[chainId.toString()]
    const { rpc } = networkConfig
    const { fallbackRPCs } = networkConfig

    // Create Blockchain instance with new constructor
    const blockchain = new Blockchain(this.keyManager, rpc, chainId, fallbackRPCs)

    // Cache the instance
    this.blockchains.set(chainId, blockchain)

    return blockchain
  }

  /**
   * Get all initialized Blockchain instances
   *
   * @returns Array of all Blockchain instances
   */
  getAllBlockchains(): Blockchain[] {
    return Array.from(this.blockchains.values())
  }

  /**
   * Remove a Blockchain instance from the registry.
   * Useful for cleanup or when a network is no longer supported.
   *
   * @param chainId - The chain ID to remove
   */
  removeBlockchain(chainId: number): void {
    if (this.blockchains.has(chainId)) {
      this.blockchains.delete(chainId)
    }
  }

  /**
   * Clear all Blockchain instances from the registry.
   * Useful for cleanup or testing.
   */
  clear(): void {
    this.blockchains.clear()
  }

  /**
   * Get the number of initialized Blockchain instances
   */
  getBlockchainCount(): number {
    return this.blockchains.size
  }
}
