import { ethers, Signer, Provider } from 'ethers'
import { RPCS } from '../@types/blockchain'
import { OceanNodeKeys } from '../@types'

export class Blockchain {
  private signer: Signer
  private providers: { [chainId: number]: Provider } = {}
  private supportedChains: string[] = []

  public constructor(networks: RPCS, nodeKeys: OceanNodeKeys) {
    console.log(
      'process.env.PRIVATE_KEY.substring(2) ',
      process.env.PRIVATE_KEY.substring(2)
    )
    console.log(' OceanNodeKeys private key ', nodeKeys.publicKey.getPrivateKeyBytes())
    const chainIds = Object.keys(networks)
    this.supportedChains = chainIds
    chainIds.forEach((chain) => {
      this.providers[parseInt(chain)] = new ethers.JsonRpcProvider(networks[chain])
    })

    this.signer = new ethers.Wallet(nodeKeys.publicKey.getPrivateKeyBytes())
    // this.signer = new ethers.Wallet(process.env.PRIVATE_KEY.substring(2))
  }

  public getSigner(): ethers.Signer {
    return this.signer
  }

  public getProvider(chain: number): ethers.Provider {
    return this.providers[chain]
  }

  public getSupportedChains(): string[] {
    return this.supportedChains
  }

  //   public getMiddleware(): ethers.providers.Provider {
  //     return this.middleware
  //   }
}
