import { ethers, Signer, Provider } from 'ethers'

export class Blockchain {
  private signer: Signer
  private provider: Provider
  private chainId: number

  public constructor(rpc: string, chaindId: number) {
    this.chainId = chaindId
    this.provider = new ethers.JsonRpcProvider(rpc)
    this.signer = new ethers.Wallet(process.env.PRIVATE_KEY.substring(2))
  }

  public getSigner(): Signer {
    return this.signer
  }

  public getProvider(): Provider {
    return this.provider
  }

  public getSupportedChains(): number {
    return this.chainId
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
    const signerAddr = await ethers.verifyMessage(message, signature)
    if (signerAddr !== address) {
      return false
    }
    return true
  } catch (err) {
    return false
  }
}
