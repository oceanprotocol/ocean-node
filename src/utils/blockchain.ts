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

export class Blockchain {
  private signer: Signer
  private provider: JsonRpcApiProvider
  private chainId: number
  private knownRPCs: string[] = []
  private networkAvailable: boolean = false

  public constructor(rpc: string, chaindId: number, fallbackRPCs?: string[]) {
    this.chainId = chaindId
    this.provider = new ethers.JsonRpcProvider(rpc)
    this.registerForNetworkEvents(this.provider)
    this.knownRPCs.push(rpc)
    if (fallbackRPCs && fallbackRPCs.length > 0) {
      this.knownRPCs.push(...fallbackRPCs)
    }
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

  public isNetworkReady(): boolean {
    return this.networkAvailable || this.provider.ready
  }

  // _detectNetwork throws error if network is not available
  public detectProviderNetwork(): boolean {
    try {
      this.provider._detectNetwork()
      this.networkAvailable = true
      return true
    } catch (error) {
      return false
    }
  }

  public getKnownRPCs(): string[] {
    return this.knownRPCs
  }

  // try other rpc options, if available
  public async tryFallbackRPCs(): Promise<boolean> {
    if (this.knownRPCs.length <= 1) {
      return false
    }
    for (let i = 1; i < this.knownRPCs.length; i++) {
      const newProvider = new JsonRpcProvider(this.knownRPCs[i])
      // try them 1 by 1 and wait a couple of secs for network detection
      this.registerForNetworkEvents(newProvider)
      await sleep(2500)
      if (this.isNetworkReady()) {
        return true
      }
    }
    return false
  }

  private registerForNetworkEvents(provider: ethers.JsonRpcApiProvider) {
    this.provider = provider
    this.provider.on('network', (newNetwork) => {
      // When a Provider makes its initial connection, it emits a "network"
      // event with a null oldNetwork along with the newNetwork. So, if the
      // oldNetwork exists, it represents a changing network
      this.networkAvailable = newNetwork instanceof Network
    })
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
