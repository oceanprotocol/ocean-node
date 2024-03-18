import { ethers } from 'ethers'
import { HTTP_LOGGER } from './logging/common.js'
import { getAllowedAdmins } from './index.js'

export function validateSignature(expiryTimestamp: number, signature: string): boolean {
  try {
    const message = expiryTimestamp.toString()
    HTTP_LOGGER.logMessage(`message: ${message}`)
    const consumerMessage = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(message))]
    )
    HTTP_LOGGER.logMessage(`consumer message: ${consumerMessage}`)
    const messageHashBytes = ethers.toBeArray(consumerMessage)
    HTTP_LOGGER.logMessage(`messageHashBytes: ${messageHashBytes}`)

    const addressFromHashSignature = ethers.verifyMessage(consumerMessage, signature)
    const addressFromBytesSignature = ethers.verifyMessage(messageHashBytes, signature)
    HTTP_LOGGER.logMessage(
      `hash: ${addressFromHashSignature} bytes: ${addressFromBytesSignature}`
    )

    if (
      ethers.getAddress(addressFromHashSignature) !==
      ethers.getAddress(addressFromBytesSignature)
    ) {
      HTTP_LOGGER.logMessage(
        `Signer address mismatches! hash: ${addressFromHashSignature} bytes: ${addressFromBytesSignature}`
      )
    }
    const signerAddress = ethers.verifyMessage(message, signature).toLowerCase()
    HTTP_LOGGER.logMessage(`signerAddress: ${signerAddress}`)
    HTTP_LOGGER.logMessage(`Resolved signer address: ${addressFromHashSignature}`)
    const allowedAdmins = getAllowedAdmins()
    const currentTimestamp = new Date().getTime()
    for (const address of allowedAdmins) {
      HTTP_LOGGER.logMessage(
        `address: ${ethers.getAddress(address)} and hash signature ${ethers.getAddress(
          addressFromHashSignature
        )}`
      )
      if (
        ethers.getAddress(address) === ethers.getAddress(addressFromHashSignature) &&
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
