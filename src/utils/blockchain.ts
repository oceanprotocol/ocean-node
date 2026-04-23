import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }
import {
  ethers,
  Signer,
  Contract,
  JsonRpcProvider,
  FallbackProvider,
  isAddress,
  parseUnits,
  Wallet,
  TransactionReceipt
} from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
import { ConnectionStatus } from '../@types/blockchain.js'

import { KeyManager } from '../components/KeyManager/index.js'

export class Blockchain {
  private keyManager: KeyManager
  private signer: Signer
  private provider: FallbackProvider
  private chainId: number
  private knownRPCs: string[] = []

  /**
   * Constructor overloads:
   * 1. New pattern: (rpc, chainId, signer, fallbackRPCs?) - signer provided by KeyManager
   * 2. Old pattern: (rpc, chainId, config, fallbackRPCs?) - for backward compatibility
   */
  public constructor(
    keyManager: KeyManager,
    rpc: string,
    chainId: number,
    fallbackRPCs?: string[]
  ) {
    this.chainId = chainId
    this.keyManager = keyManager
    this.knownRPCs.push(rpc)
    if (fallbackRPCs && fallbackRPCs.length > 0) {
      this.knownRPCs.push(...fallbackRPCs)
    }
    this.provider = undefined as undefined as FallbackProvider
    this.signer = undefined as unknown as Signer
  }

  public getSupportedChain(): number {
    return this.chainId
  }

  public getWallet(): Wallet {
    return this.keyManager.getEthWallet()
  }

  public async getWalletAddress(): Promise<string> {
    return await this.signer.getAddress()
  }

  public stop() {
    if (this.provider) {
      this.provider.providerConfigs.forEach((config) => {
        // Each config contains a 'provider' property
        config.provider.destroy()
      })

      // 2. Destroy the FallbackProvider itself
      this.provider.destroy()
      this.provider = null
    }
  }

  public async getProvider(force: boolean = false): Promise<FallbackProvider> {
    if (!this.provider) {
      const configs: {
        provider: JsonRpcProvider
        priority: number
        stallTimeout: number
      }[] = []

      const PRIMARY_RPC_TIMEOUT = 3000
      const FALLBACK_RPC_TIMEOUT = 1500
      for (let i = 0; i < this.knownRPCs.length; i++) {
        const rpc = this.knownRPCs[i]
        const rpcProvider = new JsonRpcProvider(rpc)
        if (!force) {
          try {
            const { chainId } = await rpcProvider.getNetwork()
            if (chainId.toString() === this.chainId.toString()) {
              // primary RPC gets lowest priority = is first to be called
              configs.push({
                provider: rpcProvider,
                priority: i + 1,
                stallTimeout: i === 0 ? PRIMARY_RPC_TIMEOUT : FALLBACK_RPC_TIMEOUT
              })
            }
          } catch (error) {
            CORE_LOGGER.error(`Error getting network for RPC ${rpc}: ${error}`)
          }
        } else {
          configs.push({
            provider: rpcProvider,
            priority: i + 1,
            stallTimeout: i === 0 ? PRIMARY_RPC_TIMEOUT : FALLBACK_RPC_TIMEOUT
          })
        }
      }
      // quorum=1: accept the first response to avoid calls to all configured rpcs
      this.provider =
        configs.length > 0
          ? new FallbackProvider(configs, undefined, { quorum: 1 })
          : new FallbackProvider([])
    }
    return this.provider
  }

  public async getSigner(): Promise<Signer> {
    if (!this.signer) {
      if (!this.provider) {
        await this.getProvider()
      }
      this.signer = await this.keyManager.getEvmSigner(this.provider, this.chainId)
    }
    return this.signer
  }

  public async isNetworkReady(): Promise<ConnectionStatus> {
    return await this.detectNetwork()
  }

  public getKnownRPCs(): string[] {
    return this.knownRPCs
  }

  public async calculateGasCost(to: string, amount: bigint): Promise<bigint> {
    const provider = await this.getProvider()
    const estimatedGas = await provider.estimateGas({
      to,
      value: amount
    })

    const block = await provider.getBlock('latest')
    const baseFee = block.baseFeePerGas
    const priorityFee = parseUnits('2', 'gwei')
    const maxFee = baseFee + priorityFee
    const gasCost = estimatedGas * maxFee

    return amount + gasCost
  }

  public async sendTransaction(
    signer: Signer,
    to: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    const tx = await signer.sendTransaction({
      to,
      value: amount
    })
    const receipt = await tx.wait()

    return receipt
  }

  private async detectNetwork(): Promise<ConnectionStatus> {
    const provider = await this.getProvider()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // timeout, hanging or invalid connection
        CORE_LOGGER.error(`Unable to detect provider network: (TIMEOUT)`)
        resolve({ ready: false, error: 'TIMEOUT' })
      }, 3000)
      provider
        .getBlock('latest')
        .then((block) => {
          clearTimeout(timeout)
          resolve({ ready: block.hash !== null })
        })
        .catch((err) => {
          CORE_LOGGER.error(`Unable to detect provider network: ${err.message}`)
          clearTimeout(timeout)
          resolve({ ready: false, error: err.message })
        })
    })
  }

  /* private registerForNetworkEvents() {
    this.provider.on('network', this.networkChanged)
  }

  private networkChanged(newNetwork: any) {
    // When a Provider makes its initial connection, it emits a "network"
    // event with a null oldNetwork along with the newNetwork. So, if the
    // oldNetwork exists, it represents a changing network
    this.networkAvailable = newNetwork instanceof Network
  } */

  public async getFairGasPrice(gasFeeMultiplier: number): Promise<string> {
    const signer = await this.getSigner()
    const price = (await signer.provider.getFeeData()).gasPrice
    const x = BigInt(price.toString())
    if (gasFeeMultiplier) {
      const res = BigInt(price.toString()) * BigInt(gasFeeMultiplier)
      return res.toString(10)
    } else return x.toString()
  }

  public async getGasOptions(estGas: bigint, gasFeeMultiplier: number) {
    const feeData = await this.signer.provider.getFeeData()
    const gasLimit = estGas + 20_000n

    if (feeData.maxPriorityFeePerGas) {
      const multiplier = BigInt(Math.round(gasFeeMultiplier * 100))

      const priority = (feeData.maxPriorityFeePerGas * multiplier) / 100n
      const maxFee = (feeData.maxFeePerGas * multiplier) / 100n

      const minFee = 1n

      return {
        gasLimit,
        maxPriorityFeePerGas: priority < minFee ? minFee : priority,
        maxFeePerGas: maxFee < minFee ? minFee : maxFee
      }
    }

    return {
      gasLimit,
      gasPrice: feeData.gasPrice
    }
  }
}

export async function getDatatokenDecimals(
  datatokenAddress: string,
  provider: ethers.Provider
): Promise<number> {
  const datatokenContract = new Contract(datatokenAddress, ERC20Template.abi, provider)
  try {
    return await datatokenContract.decimals()
  } catch (err) {
    CORE_LOGGER.error(`${err}. Returning default 18 decimals.`)
    return 18
  }
}

/**
 * Verify a signed message, see if signature matches address
 * @param message to verify
 * @param address to check against
 * @param signature to validate
 * @returns boolean
 */
export function verifyMessage(
  message: string | Uint8Array,
  address: string,
  signature: string
) {
  try {
    if (!isAddress(address)) {
      CORE_LOGGER.error(`${address} is not a valid web3 address`)
      return false
    }
    const signerAddr = ethers.verifyMessage(message, signature)
    if (signerAddr?.toLowerCase() !== address?.toLowerCase()) {
      return false
    }
    return true
  } catch (err) {
    return false
  }
}

export function getMessageHash(message: string): Uint8Array {
  const messageHash = ethers.solidityPackedKeccak256(
    ['bytes'],
    [ethers.hexlify(ethers.toUtf8Bytes(message))]
  )
  const messageHashBytes = ethers.toBeArray(messageHash)
  return messageHashBytes
}
