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
