import { ethers } from 'ethers'
import { HTTP_LOGGER } from './logging/common.js'
import { getAllowedAdmins } from './index.js'

export function validateSignature(
  expiryTimestamp: number,
  signature: string
): [boolean, string] {
  try {
    const message = expiryTimestamp.toString()
    const signerAddress = ethers.verifyMessage(message, signature).toLowerCase()
    HTTP_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)
    const allowedAdmins = getAllowedAdmins()
    if (allowedAdmins.length === 0) {
      const errorMsg = "Allowed admins list is empty. Please add admins' addresses."
      HTTP_LOGGER.logMessage(errorMsg)
      return [false, errorMsg]
    }
    const currentTimestamp = new Date().getTime()
    for (const address of allowedAdmins) {
      if (
        ethers.getAddress(address) === ethers.getAddress(signerAddress) &&
        currentTimestamp < expiryTimestamp
      ) {
        return [true, '']
      }
    }
    const errorMsg = `Signature ${signature} is invalid`
    HTTP_LOGGER.logMessage(errorMsg)
    return [false, errorMsg]
  } catch (e) {
    const errorMsg = `Error during signature validation: ${e}`
    HTTP_LOGGER.error(errorMsg)
    return [false, errorMsg]
  }
}
