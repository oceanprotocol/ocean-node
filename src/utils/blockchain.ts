import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' with { type: 'json' }
import {
  ethers,
  Signer,
  Contract,
  JsonRpcApiProvider,
  JsonRpcProvider,
  FallbackProvider,
  isAddress,
  parseUnits,
  Wallet,
  TransactionReceipt
} from 'ethers'
import { getConfiguration } from './config.js'
import { CORE_LOGGER } from './logging/common.js'
import { ConnectionStatus } from '../@types/blockchain.js'
import { ValidateChainId } from '../@types/commands.js'
import { KNOWN_CONFIDENTIAL_EVMS } from '../utils/address.js'
import { OceanNodeConfig } from '../@types/OceanNode.js'
import { KeyManager } from '../components/KeyManager/index.js'

const MIN_GAS_FEE_POLYGON = 30000000000 // minimum recommended 30 gwei polygon main and mumbai fees
const MIN_GAS_FEE_SEPOLIA = 4000000000 // minimum 4 gwei for eth sepolia testnet
const MIN_GAS_FEE_SAPPHIRE = 10000000000 // recommended for mainnet and testnet 10 gwei
const POLYGON_NETWORK_ID = 137
const MUMBAI_NETWORK_ID = 80001
const SEPOLIA_NETWORK_ID = 11155111

export class Blockchain {
  private config?: OceanNodeConfig // Optional for new constructor
  private static signers: Map<string, Signer> = new Map()
  private static providers: Map<string, JsonRpcApiProvider> = new Map()
  private keyManager: KeyManager
  private signer: Signer
  private provider: FallbackProvider
  private providers: JsonRpcProvider[] = []
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

  public async getProvider(force: boolean = false): Promise<FallbackProvider> {
    if (!this.provider) {
      for (const rpc of this.knownRPCs) {
        const rpcProvider = new JsonRpcProvider(rpc)
        // filter wrong chains or broken RPCs
        if (!force) {
          try {
            const { chainId } = await rpcProvider.getNetwork()
            if (chainId.toString() === this.chainId.toString()) {
              this.providers.push(rpcProvider)
              break
            }
          } catch (error) {
            CORE_LOGGER.error(`Error getting network for RPC ${rpc}: ${error}`)
          }
        } else {
          this.providers.push(new JsonRpcProvider(rpc))
        }
      }
      this.provider = new FallbackProvider(this.providers)
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
          console.log('detectNetwork block', block)
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

  public async getGasOptions(estGas: bigint, gasFeeMultiplier: number): Promise<{}> {
    const { chainId } = await this.signer.provider.getNetwork()
    const feeHistory = await this.signer.provider.getFeeData()
    const gasLimit = estGas + BigInt(20000)

    if (feeHistory.maxPriorityFeePerGas) {
      let aggressiveFeePriorityFeePerGas = feeHistory.maxPriorityFeePerGas.toString()
      let aggressiveFeePerGas = feeHistory.maxFeePerGas.toString()
      if (gasFeeMultiplier > 1) {
        aggressiveFeePriorityFeePerGas = (
          (feeHistory.maxPriorityFeePerGas * BigInt(gasFeeMultiplier * 100)) /
          BigInt(100)
        ).toString()
        aggressiveFeePerGas = (
          (feeHistory.maxFeePerGas * BigInt(gasFeeMultiplier * 100)) /
          BigInt(100)
        ).toString()
      }
      const overrides = {
        gasLimit,
        maxPriorityFeePerGas:
          (chainId === BigInt(MUMBAI_NETWORK_ID) ||
            chainId === BigInt(POLYGON_NETWORK_ID)) &&
          Number(aggressiveFeePriorityFeePerGas) < MIN_GAS_FEE_POLYGON
            ? MIN_GAS_FEE_POLYGON
            : chainId === BigInt(SEPOLIA_NETWORK_ID) &&
                Number(aggressiveFeePriorityFeePerGas) < MIN_GAS_FEE_SEPOLIA
              ? MIN_GAS_FEE_SEPOLIA
              : KNOWN_CONFIDENTIAL_EVMS.includes(chainId) &&
                  Number(aggressiveFeePriorityFeePerGas) < MIN_GAS_FEE_SAPPHIRE
                ? MIN_GAS_FEE_SAPPHIRE
                : Number(aggressiveFeePriorityFeePerGas),
        maxFeePerGas:
          (chainId === BigInt(MUMBAI_NETWORK_ID) ||
            chainId === BigInt(POLYGON_NETWORK_ID)) &&
          Number(aggressiveFeePerGas) < MIN_GAS_FEE_POLYGON
            ? MIN_GAS_FEE_POLYGON
            : chainId === BigInt(SEPOLIA_NETWORK_ID) &&
                Number(aggressiveFeePerGas) < MIN_GAS_FEE_SEPOLIA
              ? MIN_GAS_FEE_SEPOLIA
              : KNOWN_CONFIDENTIAL_EVMS.includes(chainId) &&
                  Number(aggressiveFeePerGas) < MIN_GAS_FEE_SAPPHIRE
                ? MIN_GAS_FEE_SAPPHIRE
                : Number(aggressiveFeePerGas)
      }
      return overrides
    } else {
      const overrides = {
        gasLimit,
        gasPrice: feeHistory.gasPrice
      }
      return overrides
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

export async function checkSupportedChainId(chainId: number): Promise<ValidateChainId> {
  const config = await getConfiguration()
  if (!chainId || !(`${chainId.toString()}` in config.supportedNetworks)) {
    CORE_LOGGER.error(`Chain ID ${chainId} is not supported`)
    return {
      validation: false,
      networkRpc: ''
    }
  }
  return {
    validation: true,
    networkRpc: config.supportedNetworks[chainId.toString()].rpc
  }
}

export async function getJsonRpcProvider(
  chainId: number
): Promise<JsonRpcProvider> | null {
  const checkResult = await checkSupportedChainId(chainId)
  if (!checkResult.validation) {
    return null
  }
  return new JsonRpcProvider(checkResult.networkRpc)
}
