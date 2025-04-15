import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import {
  ethers,
  Signer,
  Contract,
  JsonRpcApiProvider,
  JsonRpcProvider,
  isAddress,
  Network,
  parseUnits,
  Wallet,
  TransactionReceipt
} from 'ethers'
import { getConfiguration } from './config.js'
import { CORE_LOGGER } from './logging/common.js'
import { sleep } from './util.js'
import { ConnectionStatus, SupportedNetwork } from '../@types/blockchain.js'
import { ValidateChainId } from '../@types/commands.js'
import { KNOWN_CONFIDENTIAL_EVMS } from '../utils/address.js'

const MIN_GAS_FEE_POLYGON = 30000000000 // minimum recommended 30 gwei polygon main and mumbai fees
const MIN_GAS_FEE_SEPOLIA = 4000000000 // minimum 4 gwei for eth sepolia testnet
const MIN_GAS_FEE_SAPPHIRE = 10000000000 // recommended for mainnet and testnet 10 gwei
const POLYGON_NETWORK_ID = 137
const MUMBAI_NETWORK_ID = 80001
const SEPOLIA_NETWORK_ID = 11155111

export class Blockchain {
  private signer: Signer
  private provider: JsonRpcApiProvider
  private chainId: number
  private knownRPCs: string[] = []
  private network: Network
  private networkAvailable: boolean = false

  public constructor(
    rpc: string,
    chainName: string,
    chainId: number,
    fallbackRPCs?: string[]
  ) {
    this.chainId = chainId
    this.knownRPCs.push(rpc)
    if (fallbackRPCs && fallbackRPCs.length > 0) {
      this.knownRPCs.push(...fallbackRPCs)
    }
    this.network = new ethers.Network(chainName, chainId)
    // this.provider = new ethers.JsonRpcProvider(rpc, this.network)
    this.provider = new ethers.JsonRpcProvider(rpc, null, {
      staticNetwork: ethers.Network.from(chainId)
    })
    this.registerForNetworkEvents()
    // always use this signer, not simply provider.getSigner(0) for instance (as we do on many tests)
    this.signer = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider)
  }

  public getSigner(): Signer {
    return this.signer
  }

  public getProvider(): JsonRpcApiProvider {
    return this.provider
  }

  public getSupportedChain(): number {
    return this.chainId
  }

  public async getWalletAddress(): Promise<string> {
    return await this.signer.getAddress()
  }

  public async isNetworkReady(): Promise<ConnectionStatus> {
    if (this.networkAvailable && this.provider.ready) {
      return { ready: true }
    }
    return await this.detectNetwork()
  }

  public getKnownRPCs(): string[] {
    return this.knownRPCs
  }

  public async calculateGasCost(to: string, amount: bigint): Promise<bigint> {
    const provider = this.getProvider()
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
    wallet: Wallet,
    to: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    const tx = await wallet.sendTransaction({
      to,
      value: amount
    })
    const receipt = await tx.wait()

    return receipt
  }

  private detectNetwork(): Promise<ConnectionStatus> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // timeout, hanging or invalid connection
        CORE_LOGGER.error(`Unable to detect provider network: (TIMEOUT)`)
        resolve({ ready: false, error: 'TIMEOUT' })
      }, 3000)

      this.provider
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

  // try other rpc options, if available
  public async tryFallbackRPCs(): Promise<ConnectionStatus> {
    let response: ConnectionStatus = { ready: false, error: '' }
    // we also retry the original one again after all the fallbacks
    for (let i = this.knownRPCs.length - 1; i >= 0; i--) {
      this.provider.off('network')
      CORE_LOGGER.warn(`Retrying new provider connection with RPC: ${this.knownRPCs[i]}`)
      this.provider = new JsonRpcProvider(this.knownRPCs[i])
      this.signer = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider)
      // try them 1 by 1 and wait a couple of secs for network detection
      this.registerForNetworkEvents()
      await sleep(2000)
      response = await this.isNetworkReady()
      // return as soon as we have a valid one
      if (response.ready) {
        return response
      }
    }
    return response
  }

  private registerForNetworkEvents() {
    this.provider.on('network', this.networkChanged)
  }

  private networkChanged(newNetwork: any) {
    // When a Provider makes its initial connection, it emits a "network"
    // event with a null oldNetwork along with the newNetwork. So, if the
    // oldNetwork exists, it represents a changing network
    this.networkAvailable = newNetwork instanceof Network
  }

  public async getFairGasPrice(gasFeeMultiplier: number): Promise<string> {
    const price = await (await this.signer.provider.getFeeData()).gasPrice
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
export async function verifyMessage(
  message: string | Uint8Array,
  address: string,
  signature: string
) {
  try {
    if (!isAddress(address)) {
      CORE_LOGGER.error(`${address} is not a valid web3 address`)
      return false
    }
    const signerAddr = await ethers.verifyMessage(message, signature)
    if (signerAddr?.toLowerCase() !== address?.toLowerCase()) {
      return false
    }
    return true
  } catch (err) {
    return false
  }
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

// useful for getting a Blockchain instance, as we repeat this piece of code often
export function getBlockchainHandler(network: SupportedNetwork): Blockchain {
  const blockChain = new Blockchain(
    network.rpc,
    network.network,
    network.chainId,
    network.fallbackRPCs
  )
  return blockChain
}

/**
 * Returns a contract instance for the given address
 * @param {string} address - The address of the contract
 * @param {AbiItem[]} [abi] - The ABI of the contract
 * @returns {Contract} - The contract instance
 */
export function getContract(address: string, abi: any, signer: Signer): Contract {
  const contract = new ethers.Contract(address, abi, signer)
  return contract
}
