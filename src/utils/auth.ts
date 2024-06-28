import { ethers } from 'ethers'
import { CORE_LOGGER } from './logging/common.js'
import { getAllowedAdmins } from './index.js'
import { CommonValidation } from '../components/httpRoutes/requestValidator.js'

export function validateAdminSignature(
  expiryTimestamp: number,
  signature: string
): CommonValidation {
  try {
    const message = expiryTimestamp.toString()
    const signerAddress = ethers.verifyMessage(message, signature)?.toLowerCase()
    CORE_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)
    const allowedAdmins = getAllowedAdmins()
    if (allowedAdmins.length === 0) {
      const errorMsg = "Allowed admins list is empty. Please add admins' addresses."
      CORE_LOGGER.logMessage(errorMsg)
      return { valid: false, error: errorMsg }
    }
    const currentTimestamp = new Date().getTime()
    if (currentTimestamp > expiryTimestamp) {
      const errorMsg = `The expiryTimestamp ${expiryTimestamp} sent for validation is in the past. Therefore signature ${signature} is rejected`
      CORE_LOGGER.logMessage(errorMsg)
      return { valid: false, error: errorMsg }
    }
    for (const address of allowedAdmins) {
      if (
        ethers.getAddress(address)?.toLowerCase() ===
        ethers.getAddress(signerAddress)?.toLowerCase()
      ) {
        return { valid: true, error: '' }
      }
    }
    const errorMsg = `The address which signed the message is not on the allowed admins list. Therefore signature ${signature} is rejected`
    CORE_LOGGER.logMessage(errorMsg)
    return { valid: false, error: errorMsg }
  } catch (e) {
    const errorMsg = `Error during signature validation: ${e}`
    CORE_LOGGER.error(errorMsg)
    return { valid: false, error: errorMsg }
  }
}
