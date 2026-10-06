import AccessListJson from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }
import { ethers, Signer } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
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
    if (Number(balance) > 0) {
      return true
    } else {
      CORE_LOGGER.error(
        `Account ${addressToCheck} is NOT part of the given access list group.`
      )
      return false
    }
  } catch (error) {
    CORE_LOGGER.error(
      `Failed to check access list ${accessListContractAddress}: ${error.message}`
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
          CORE_LOGGER.logMessage(
            `Blockchain instance not available for chain ${chainId}, skipping access list check`,
            true
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
        CORE_LOGGER.logMessage(
          `Failed to check access lists on chain ${chain}: ${error.message}`,
          true
        )
      }
    }
  }

  return false
}
