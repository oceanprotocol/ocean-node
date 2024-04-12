import axios from 'axios'
import { DDO } from '../@types/DDO/DDO'
import { Service } from '../@types/DDO/Service'
import { DDO_IDENTIFIER_PREFIX } from './constants.js'
import { CORE_LOGGER } from './logging/common.js'
import { createHash } from 'crypto'
import { getAddress } from 'ethers'

// Notes:
// Asset as per asset.py on provider, is a class there, while on ocean.Js we only have a type
// this is an utility to extract information from the Asset services
export const AssetUtils = {
  getServiceIndexById(asset: DDO, id: string): number | null {
    for (let c = 0; c < asset.services.length; c++)
      if (asset.services[c].id === id) return c
    return null
  },
  getServiceByIndex(asset: DDO, index: number): Service | null {
    if (index >= 0 && index < asset.services.length) {
      return asset.services[index]
    }
    return null
  },

  getServiceById(asset: DDO, id: string): Service | null {
    const services = asset.services.filter((service: Service) => service.id === id)
    return services.length ? services[0] : null
  }
}

export async function fetchFileMetadata(
  url: string
): Promise<{ contentLength: string; contentType: string }> {
  let contentLength: string = ''
  let contentType: string = ''
  try {
    // First try with HEAD request
    const response = await axios.head(url)

    contentLength = response.headers['content-length']
    contentType = response.headers['content-type']
  } catch (error) {
    // Fallback to GET request
    try {
      const response = await axios.get(url, { method: 'GET', responseType: 'stream' })

      contentLength = response.headers['content-length']
      contentType = response.headers['content-type']
    } catch (error) {
      contentLength = 'Unknown'
    }
  }

  if (!contentLength) {
    try {
      const response = await axios.get(url, { responseType: 'stream' })
      let totalSize = 0

      for await (const chunk of response.data) {
        totalSize += chunk.length
      }
      contentLength = totalSize.toString()
    } catch (error) {
      contentLength = 'Unknown'
    }
  }
  return {
    contentLength,
    contentType
  }
}

/**
 * Validates if a given DDO identifier matches the NFT address and the chain ID provided
 * @param ddoID the ID of the DDO
 * @param nftAddress the nft address
 * @param chainId the chain id
 * @returns validation result
 */
export function validateDDOHash(
  ddoID: string,
  nftAddress: string,
  chainId: number
): boolean {
  if (!ddoID || !nftAddress || !chainId) {
    CORE_LOGGER.error('Invalid or missing data for proper DDO id validation')
    return false
  }
  const hashAddressAndChain: string = generateDDOHash(nftAddress, chainId)
  return ddoID === hashAddressAndChain
}

/**
 * Generates DDO Id given the chain and nft address provided
 * @param nftAddress the nft address
 * @param chainId the chain id
 * @returns did
 */
export function generateDDOHash(nftAddress: string, chainId: number): string | null {
  if (!nftAddress || !chainId) {
    CORE_LOGGER.error('Invalid or missing data for proper DDO id hash generation')
    return null
  }
  const hashAddressAndChain: string = createHash('sha256')
    .update(getAddress(nftAddress) + chainId.toString(10))
    .digest('hex')

  return DDO_IDENTIFIER_PREFIX + hashAddressAndChain
}
