import { isAddress } from 'ethers'
import { SUPPORTED_PROTOCOL_COMMANDS, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { EncryptMethod } from '../../@types/fileObject.js'

export type ValidateParams = {
  valid: boolean
  reason?: string
  status?: number
}

export function validateBroadcastParameters(requestBody: any): ValidateParams {
  // for now we can use the same validation function,
  // but later we might need to have separate validation functions
  // if we many different commands of each type
  return validateCommandAPIParameters(requestBody)
}
// add others when we add support
export function validateCommandAPIParameters(requestBody: any): ValidateParams {
  // eslint-disable-next-line prefer-destructuring
  const command: string = requestBody.command as string

  if (!command) {
    return buildInvalidRequestMessage('Invalid Request: "command" is mandatory!')
  }
  // direct commands
  if (SUPPORTED_PROTOCOL_COMMANDS.includes(command)) {
    if (
      command === PROTOCOL_COMMANDS.FIND_DDO ||
      command === PROTOCOL_COMMANDS.GET_DDO ||
      command === PROTOCOL_COMMANDS.VALIDATE_DDO
    ) {
      // message is DDO identifier
      if (!requestBody.id || !requestBody.id.startsWith('did:op')) {
        return buildInvalidRequestMessage('Missing or invalid required parameter: "id"')
      }
      if (
        command === PROTOCOL_COMMANDS.VALIDATE_DDO &&
        (!requestBody.chainId || !requestBody.nftAddress)
      ) {
        return buildInvalidRequestMessage(
          'Missing required parameter(s): "chainId", "nftAddress"'
        )
      }
    }
    // nonce
    else if (command === PROTOCOL_COMMANDS.NONCE) {
      // needs a valid and mandatory address
      if (!requestBody.address || !isAddress(requestBody.address)) {
        return buildInvalidRequestMessage(
          !requestBody.address
            ? 'Missing required parameter: "address"'
            : 'Parameter : "address" is not a valid web3 address'
        )
      }
    } else if (command === PROTOCOL_COMMANDS.QUERY) {
      if (!requestBody.query) {
        return buildInvalidRequestMessage('Missing required parameter: "query"')
      }
    } else if (command === PROTOCOL_COMMANDS.ENCRYPT) {
      if (!requestBody.blob) {
        return buildInvalidRequestMessage('Missing required parameter: "blob"')
      }
      if (!requestBody.encoding) {
        requestBody.encoding = 'string'
      }
      if (!['string', 'base58'].includes(requestBody.encoding)) {
        return buildInvalidRequestMessage(
          'Invalid parameter: "encoding" must be String | Base58'
        )
      }
      if (!requestBody.encryptionType) {
        requestBody.encoding = EncryptMethod.ECIES
      }
      if (
        ![EncryptMethod.AES, EncryptMethod.ECIES].includes(requestBody.encryptionType)
      ) {
        return buildInvalidRequestMessage(
          'Invalid parameter: "encryptionType" must be AES | ECIES'
        )
      }
    } else if (command === PROTOCOL_COMMANDS.GET_FEES) {
      if (!requestBody.ddo || !requestBody.serviceId) {
        return buildInvalidRequestMessage(
          'Missing required parameter(s): "ddo","serviceId"'
        )
      }
    } else if (command === PROTOCOL_COMMANDS.REINDEX) {
      if (!requestBody.txId || !requestBody.chainId) {
        return buildInvalidRequestMessage(
          'Missing required parameter(s): "txId","chainId"'
        )
      }
    } else if (command === PROTOCOL_COMMANDS.DECRYPT_DDO) {
      if (
        !requestBody.decrypterAddress ||
        !requestBody.chainId ||
        !requestBody.nonce ||
        !requestBody.signature
      ) {
        return buildInvalidRequestMessage(
          'Missing required parameter(s): "decrypterAddress","chainId","nonce","signature"'
        )
      }
    } else if (command === PROTOCOL_COMMANDS.DOWNLOAD) {
      if (
        !requestBody.fileIndex ||
        !requestBody.documentId ||
        !requestBody.serviceId ||
        !requestBody.transferTxId ||
        !requestBody.nonnce ||
        !requestBody.consumerAddress ||
        !requestBody.signature
      ) {
        return buildInvalidRequestMessage(
          'Missing required parameter(s): "fileIndex","documentId", "serviceId","transferTxId", "nonce","consumerAddress", "signature"'
        )
      }
    } else if (command === PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS) {
      if (!requestBody.chainId) {
        return buildInvalidRequestMessage('Missing required parameter: "chainId"')
      }
    }
    // only once is enough :-)
    return {
      valid: true
    }
  }
  return buildInvalidRequestMessage(`Invalid or unrecognized command: "${command}"`)
}

// aux function as we are repeating same block of code all the time, only thing that changes is reason msg
function buildInvalidRequestMessage(cause: string): ValidateParams {
  return {
    valid: false,
    status: 400,
    reason: cause
  }
}
