import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import {
  ethers,
  Signer,
  Contract,
  JsonRpcApiProvider,
  JsonRpcProvider,
  isAddress,
  Network
} from 'ethers'
import { getConfiguration } from './config.js'
import { CORE_LOGGER } from './logging/common.js'
import { sleep } from './util.js'
import { ConnectionStatus } from '../@types/blockchain.js'

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
    this.provider = new ethers.JsonRpcProvider(rpc, this.network)
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

  public async isNetworkReady(): Promise<ConnectionStatus> {
    if (this.networkAvailable || this.provider.ready) {
      return { ready: true }
    }
    return await this.detectNetwork()
  }

  public getKnownRPCs(): string[] {
    return this.knownRPCs
  }

  private detectNetwork(): Promise<ConnectionStatus> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // timeout, hanging or invalid connection
        CORE_LOGGER.error(`Unable to detect provider network: (TIMEOUT)`)
        resolve({ ready: false, error: 'TIMEOUT' })
      }, 3000)
      this.provider
        ._detectNetwork()
        .then((network) => {
          clearTimeout(timeout)
          resolve({ ready: network instanceof Network })
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
}

export async function getDatatokenDecimals(
  datatokenAddress: string,
  provider: JsonRpcProvider
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
    if (signerAddr.toLowerCase() !== address.toLowerCase()) {
      return false
    }
    return true
  } catch (err) {
    return false
  }
}

export async function checkSupportedChainId(chainId: number): Promise<[boolean, string]> {
  const config = await getConfiguration()
  if (!(`${chainId.toString()}` in config.supportedNetworks)) {
    CORE_LOGGER.error(`Chain ID ${chainId.toString()} is not supported`)
    return [false, '']
  }
  return [true, config.supportedNetworks[chainId.toString()].rpc]
}

export async function getJsonRpcProvider(
  chainId: number
): Promise<JsonRpcProvider> | null {
  const checkResult = await checkSupportedChainId(chainId)
  if (!checkResult[0]) {
    return null
  }
  return new JsonRpcProvider(checkResult[1])
}
