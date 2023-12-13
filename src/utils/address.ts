import fs from 'fs'
import { homedir } from 'os'
import addresses from '@oceanprotocol/contracts/addresses/address.json' assert { type: 'json' }

/**
 * Get the artifacts address from the address.json file
 * either from the env or from the ocean-contracts dir
 * @returns data or null
 */
export function getOceanArtifactsAdresses(): any {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const data = fs.readFileSync(
      process.env.ADDRESS_FILE ||
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
      'utf8'
    )
    return JSON.parse(data)
  } catch (error) {
    return null
  }
}
// default token addresses per chain
export const OCEAN_ARTIFACTS_ADDRESSES_PER_CHAIN = addresses
