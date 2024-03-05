import { sha256, toUtf8Bytes, verifyMessage } from 'ethers'
import { HTTP_LOGGER } from '../../../../utils/logging/common'
import { existsEnvironmentVariable } from '../../../../utils/config.js'

export function validateSignature(
  nonce: number,
  expiryTimestamp: number,
  signature: string
): boolean {
  try {
    const message = sha256(
      toUtf8Bytes(nonce.toString() + '-' + expiryTimestamp.toString())
    )
    HTTP_LOGGER.logMessage(`Message for signature validation: ${message}`)

    const signerAddress = verifyMessage(message, signature).toLowerCase()
    HTTP_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)

    if (!existsEnvironmentVariable('ALLOWED_ADMINS')) {
      HTTP_LOGGER.logMessage(`Missing env var for ALLOWED_ADMINS`)
    }
    const currentTimestamp = new Date().getTime()
    for (const address of JSON.parse(process.env.ALLOWED_ADMINS)) {
      if (address.lowercase() === signerAddress && currentTimestamp < expiryTimestamp) {
        HTTP_LOGGER.logMessage(`Signature is valid`)
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
