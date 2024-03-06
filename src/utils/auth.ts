import { sha256, toUtf8Bytes, verifyMessage } from 'ethers'
import { HTTP_LOGGER } from './logging/common.js'
import { existsEnvironmentVariable } from './config.js'

export function validateSignature(expiryTimestamp: number, signature: string): boolean {
  try {
    const message = sha256(toUtf8Bytes(expiryTimestamp.toString()))

    const signerAddress = verifyMessage(message, signature).toLowerCase()
    HTTP_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)

    if (!existsEnvironmentVariable('ALLOWED_ADMINS')) {
      HTTP_LOGGER.logMessage(`Missing env var for ALLOWED_ADMINS`)
    }
    const currentTimestamp = new Date().getTime()
    for (const address of JSON.parse(process.env.ALLOWED_ADMINS)) {
      if (address.lowercase() === signerAddress && currentTimestamp < expiryTimestamp) {
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
