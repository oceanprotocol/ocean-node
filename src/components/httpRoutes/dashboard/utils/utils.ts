import { sha256, toUtf8Bytes, verifyMessage } from 'ethers'
import { HTTP_LOGGER } from '../../../../utils/logging/common'
import { existsEnvironmentVariable } from '../../../../utils/config.js'

import { NonceDatabase } from '../../../database/index.js'

export async function validateSignatureAndNonce(
  nonce: number,
  expiryTimestamp: string,
  signature: string,
  db: NonceDatabase
): Promise<boolean> {
  try {
    const message = sha256(toUtf8Bytes(nonce.toString() + '-' + expiryTimestamp))
    HTTP_LOGGER.logMessage(`Message for signature validation: ${message}`)

    const signerAddress = verifyMessage(message, signature).toLowerCase()
    HTTP_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)

    if (!existsEnvironmentVariable('ALLOWED_ADMINS')) {
      HTTP_LOGGER.logMessage(`Missing env var for ALLOWED_ADMINS`)
    }
    for (const address of JSON.parse(process.env.ALLOWED_ADMINS)) {
      if (address.lowercase() === signerAddress) {
        HTTP_LOGGER.logMessage(`Signature is valid`)
        // Nonce validation
        const existingNonce = await db.retrieve(address)
        if (nonce > existingNonce.nonce) {
          HTTP_LOGGER.logMessage(`Nonce is valid`)
          return true
        } else {
          HTTP_LOGGER.logMessage(`Nonce ${nonce} is invalid`)
          return false
        }
      }
    }
    HTTP_LOGGER.logMessage(`Signature ${signature} is invalid`)
    return false
  } catch (e) {
    HTTP_LOGGER.error(`Error during signature and nonce validation: ${e}`)
    return false
  }
}
