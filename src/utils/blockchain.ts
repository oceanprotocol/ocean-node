import { ethers, Signer, Provider } from 'ethers'
import { RPCS } from '../@types/blockchain'
import { OceanNodeKeys } from '../@types'

export class Blockchain {
  private signer: Signer
  private providers: { [chainId: number]: Provider }
  private supportedChains: number[]

  public constructor(networks: RPCS, nodeKeys: OceanNodeKeys) {
    this.signer = new ethers.Wallet(nodeKeys.privateKey)
    const chainIds = Object.keys(networks)
    for (const chain in chainIds) {
      this.supportedChains.push(parseInt(chain))
      this.providers[parseInt(chain)] = new ethers.JsonRpcProvider(networks[chain])
    }
  }

  public getSigner(): ethers.Signer {
    return this.signer
  }

  public getProvider(chain: number): ethers.Provider {
    return this.providers[chain]
  }

  //   public getMiddleware(): ethers.providers.Provider {
  //     return this.middleware
  //   }
}
