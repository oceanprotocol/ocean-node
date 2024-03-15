import fs from 'fs'
import addresses from '@oceanprotocol/contracts/addresses/address.json' assert { type: 'json' }
import { CORE_LOGGER } from './logging/common.js'
import { ENVIRONMENT_VARIABLES, existsEnvironmentVariable } from './index.js'

/**
 * Get the artifacts address from the address.json file
 * either from the env or from the ocean-contracts dir
 * @returns data or null
 */
export function getOceanArtifactsAdresses(): any {
  try {
    if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.ADDRESS_FILE)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      console.log(
        ' ENVIRONMENT_VARIABLES.ADDRESS_FILE.value ',
        ENVIRONMENT_VARIABLES.ADDRESS_FILE.value
      )
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
// default token addresses per chain
export const OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN = addresses
export const DEVELOPMENT_CHAIN_ID = 8996
