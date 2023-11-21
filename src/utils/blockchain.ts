import { ethers, Signer, Provider } from 'ethers'
import { RPCS } from '../@types/blockchain'
import { OceanNodeKeys } from '../@types'
import fs from 'fs'
import { homedir } from 'os'

export class Blockchain {
  private signer: Signer
  private providers: { [chainId: number]: Provider } = {}
  private supportedChains: string[] = []

  public constructor(networks: RPCS, nodeKeys: OceanNodeKeys) {
    const chainIds = Object.keys(networks)
    this.supportedChains = chainIds
    chainIds.forEach((chain) => {
      this.providers[parseInt(chain)] = new ethers.JsonRpcProvider(networks[chain])
    })

    this.signer = new ethers.Wallet(process.env.PRIVATE_KEY.substring(2))
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

  public getNetworkNameByChainId(chainId: string): string {
    // TODO - change me in indexer logic
    let networkName: string
    const addressFile = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.readFileSync(
        process.env.ADDRESS_FILE ||
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
        'utf8'
      )
    )
    const networkKeys = Object.keys(addressFile)
    networkKeys.forEach((key) => {
      if (addressFile[key].chainId === parseInt(chainId)) {
        networkName = key
      }
    })

    return networkName
  }
}
