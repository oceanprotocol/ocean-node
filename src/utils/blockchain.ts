import { ethers, Signer, JsonRpcApiProvider, JsonRpcProvider, Contract } from 'ethers'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }

export class Blockchain {
  private signer: Signer
  private provider: JsonRpcApiProvider
  private chainId: number

  public constructor(rpc: string, chaindId: number) {
    this.chainId = chaindId
    this.provider = new ethers.JsonRpcProvider(rpc)
    this.signer = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider)
  }

  public getSigner(): Signer {
    return this.signer
  }

  public getProvider(): JsonRpcApiProvider {
    return this.provider
  }

  public getSupportedChains(): number {
    return this.chainId
  }
}

export async function getDatatokenDecimals(
  datatokenAddress: string,
  provider: JsonRpcProvider
): Promise<number> {
  const datatokenContract = new Contract(
    datatokenAddress,
    ERC20Template.abi,
    await provider.getSigner()
  )
  return await datatokenContract.decimals()
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
    const signerAddr = await ethers.verifyMessage(message, signature)
    if (signerAddr.toLowerCase() !== address.toLowerCase()) {
      return false
    }
    return true
  } catch (err) {
    return false
  }
}
