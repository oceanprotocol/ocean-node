import AccessListJson from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }
import { ethers, Signer } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
import { LOG_LEVELS_STR } from './logging/Logger.js'
import { errorSummary } from './logging/redact.js'
import { AccessList } from '../@types/AccessList.js'
import { OceanNode } from '../OceanNode.js'

/**
 * @param accessList the access list contract address
 * @param chainId the chain id to check
 * @param addressToCheck the account address to check on the access list
 * @param signer signer for the contract part
 * @returns true if the account has balanceOf > 0 OR if the accessList is empty OR does not contain info for this chain, false otherwise
 */
export async function checkAddressOnAccessListWithSigner(
  accessListContractAddress: string,
  addressToCheck: string,
  signer: Signer
): Promise<boolean> {
  if (!accessListContractAddress) {
    return true
  }
  const accessListContract = new ethers.Contract(
    accessListContractAddress,
    AccessListJson.abi,
    signer
  )
  try {
    // if has at least 1 token than is is authorized
    const balance = await accessListContract.balanceOf(addressToCheck)
    CORE_LOGGER.resetThrottle(`accessList:${accessListContractAddress}`)
    if (Number(balance) > 0) {
      return true
    } else {
      CORE_LOGGER.debug(
        `Account ${addressToCheck} is not on access list ${accessListContractAddress}`
      )
      return false
    }
  } catch (error) {
    CORE_LOGGER.throttled(
      `accessList:${accessListContractAddress}`,
      LOG_LEVELS_STR.LEVEL_WARN,
      `Failed to check access list ${accessListContractAddress}: ${errorSummary(error)}`
    )
    return false
  }
}

export async function checkAddressOnAccessList(
  consumerAddress: string,
  access: AccessList[],
  oceanNode: OceanNode
): Promise<boolean> {
  if (!access || access.length === 0) {
    return false
  }
  const config = oceanNode.getConfig()
  const { supportedNetworks } = config
  for (const accessListMap of access) {
    if (!accessListMap) continue
    for (const chain of Object.keys(accessListMap)) {
      const { chainId } = supportedNetworks[chain]
      try {
        const blockchain = oceanNode.getBlockchain(chainId)
        if (!blockchain) {
          CORE_LOGGER.warn(
            `Blockchain instance not available for chain ${chainId}, skipping access list check`
          )
          continue
        }
        const signer = await blockchain.getSigner()
        for (const accessListAddress of accessListMap[chain]) {
          const hasAccess = await checkAddressOnAccessListWithSigner(
            accessListAddress,
            consumerAddress,
            signer
          )
          if (hasAccess) {
            return true
          }
        }
      } catch (error) {
        CORE_LOGGER.warn(
          `Failed to check access lists on chain ${chain}: ${errorSummary(error)}`
        )
      }
    }
  }

  return false
}
