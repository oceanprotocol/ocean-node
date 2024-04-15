import { ethers } from 'ethers'
import { HTTP_LOGGER } from './logging/common.js'
import { getAllowedAdmins } from './index.js'

export function validateSignature(expiryTimestamp: number, signature: string): boolean {
  try {
    const message = expiryTimestamp.toString()
    const signerAddress = ethers.verifyMessage(message, signature).toLowerCase()
    HTTP_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)
    const allowedAdmins = getAllowedAdmins()
    const currentTimestamp = new Date().getTime()
    for (const address of allowedAdmins) {
      if (
        ethers.getAddress(address.toLowerCase()) ===
          ethers.getAddress(signerAddress.toLowerCase()) &&
        currentTimestamp < expiryTimestamp
      ) {
        return true
      }
    }
    HTTP_LOGGER.logMessage(`Signature ${signature} is invalid`)
    return false
  } catch (e) {
    HTTP_LOGGER.error(`Error during signature validation: ${e}`)
    return false
  }
}
