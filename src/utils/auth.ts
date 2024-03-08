import { sha256, toUtf8Bytes, verifyMessage } from 'ethers'
import { HTTP_LOGGER } from './logging/common.js'
import { PROTOCOL_COMMANDS } from './constants.js'
import { StatusHandler } from '../components/core/statusHandler.js'
import { streamToObject } from './util.js'
import { Readable } from 'stream'
import { OceanNode } from '../OceanNode.js'

export async function validateSignature(
  expiryTimestamp: number,
  signature: string,
  oceanNode: OceanNode
): Promise<boolean> {
  try {
    const message = sha256(toUtf8Bytes(expiryTimestamp.toString()))

    const signerAddress = verifyMessage(message, signature).toLowerCase()
    HTTP_LOGGER.logMessage(`Resolved signer address: ${signerAddress}`)
    const statusCommand = {
      command: PROTOCOL_COMMANDS.STATUS
    }
    const response = await new StatusHandler(oceanNode).handle(statusCommand)
    const status = await streamToObject(response.stream as Readable)
    const currentTimestamp = new Date().getTime()
    for (const address of status.allowedAdmins) {
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
