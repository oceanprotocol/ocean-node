import fs from 'fs'
import addresses from '@oceanprotocol/contracts/addresses/address.json' assert { type: 'json' }
import { CORE_LOGGER } from './logging/common.js'
import { ENVIRONMENT_VARIABLES, existsEnvironmentVariable } from './index.js'
import { getContractAddress, getNFTFactory } from '../components/Indexer/utils.js'
import { Signer, getAddress } from 'ethers'

/**
 * Get the artifacts address from the address.json file
 * either from the env or from the ocean-contracts dir
 * @returns data or null
 */
export function getOceanArtifactsAdresses(): any {
  try {
    if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ADDRESS_FILE)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const data = fs.readFileSync(ENVIRONMENT_VARIABLES.ADDRESS_FILE.value, 'utf8')
      return JSON.parse(data)
    }
    return addresses
  } catch (error) {
    CORE_LOGGER.error(error)
    return addresses
  }
}

/**
 * Get the artifacts address from the address.json file, for the given chain
 * either from the env or from the ocean-contracts dir, safer than above, because sometimes the network name
 * is mispeled, best example "optimism_sepolia" vs "optimism-sepolia"
 * @returns data or null
 */
export function getOceanArtifactsAdressesByChainId(chain: number): any {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const data = getOceanArtifactsAdresses()
    if (data) {
      const networks = Object.keys(data)
      for (const network of networks) {
        if (data[network].chainId === chain) {
          return data[network]
        }
      }
    }
  } catch (error) {
    CORE_LOGGER.error(error)
  }
  return null
}
/**
 * Checks if a given NFT address was deployed by our NFT Factory on the specific chain
 * @param chainId chain id as number
 * @param signer the signer account
 * @param dataNftAddress the deployed nft address
 * @returns true or false
 */
export async function wasNFTDeployedByOurFactory(
  chainId: number,
  signer: Signer,
  dataNftAddress: string
): Promise<boolean> {
  const nftFactoryAddress = getContractAddress(chainId, 'ERC721Factory')
  const nftFactoryContract = await getNFTFactory(signer, nftFactoryAddress)

  const nftAddressFromFactory = await nftFactoryContract.erc721List(dataNftAddress)

  return getAddress(dataNftAddress) === getAddress(nftAddressFromFactory)
}
// default token addresses per chain
export const OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN = addresses
export const DEVELOPMENT_CHAIN_ID = 8996
