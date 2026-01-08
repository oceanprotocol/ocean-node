import AccessListJson from '@oceanprotocol/contracts/artifacts/contracts/accesslists/AccessList.sol/AccessList.json' with { type: 'json' }
import { ethers, Signer } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'

/**
 * @param accessList the access list contract address
 * @param chainId the chain id to check
 * @param addressToCheck the account address to check on the access list
 * @param signer signer for the contract part
 * @returns true if the account has balanceOf > 0 OR if the accessList is empty OR does not contain info for this chain, false otherwise
 */
export async function checkAddressOnAccessList(
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
}
