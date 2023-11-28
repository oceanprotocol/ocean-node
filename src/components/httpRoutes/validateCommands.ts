import { isAddress } from 'ethers'
import { SUPPORTED_PROTOCOL_COMMANDS, PROTOCOL_COMMANDS } from '../../utils/constants.js'

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
    return {
      valid: false,
      reason: 'Invalid Request: "command" is mandatory!',
      status: 400
    }
  }
  // direct commands
  if (SUPPORTED_PROTOCOL_COMMANDS.includes(command)) {
    // downloadURL
    if (command === PROTOCOL_COMMANDS.DOWNLOAD_URL) {
      // only mandatory is the url
      if (!requestBody.url) {
        return {
          valid: false,
          reason: 'Missing required parameter: "url"',
          status: 400
        }
      }
      return {
        valid: true
      }
      // echo
    } else if (command === PROTOCOL_COMMANDS.ECHO) {
      // nothing special with this one
      return {
        valid: true
      }
    } else if (command === PROTOCOL_COMMANDS.FIND_DDO) {
      // message is DDO identifier
      if (!requestBody.id || !requestBody.id.startsWith('did:op')) {
        return {
          valid: false,
          reason: 'Missing or invalid required parameter: "id"',
          status: 400
        }
      }
      // nonce
    } else if (command === PROTOCOL_COMMANDS.NONCE) {
      // needs a valid and mandatory address
      if (!requestBody.address || !isAddress(requestBody.address)) {
        return {
          valid: false,
          reason: !requestBody.address
            ? 'Missing required parameter: "address"'
            : 'Parameter : "address" is not a valid web3 address',
          status: 400
        }
      }
      return {
        valid: true
      }
    } else if (command === PROTOCOL_COMMANDS.GET_DDO) {
      if (!requestBody.id) {
        return {
          valid: false,
          reason: 'Missing required parameter: "id"',
          status: 400
        }
      }
      return {
        valid: true
      }
    } else if (command === PROTOCOL_COMMANDS.QUERY) {
      if (!requestBody.query) {
        return {
          valid: false,
          reason: 'Missing required parameter: "query"',
          status: 400
        }
      }
      return {
        valid: true
      }
    } else if (command === PROTOCOL_COMMANDS.ENCRYPT) {
      if (!requestBody.blob) {
        return {
          valid: false,
          reason: 'Missing required parameter: "blob"',
          status: 400
        }
      }
      if (!requestBody.encoding) {
        requestBody.encoding = 'string'
      }
      if (!['string', 'base58'].includes(requestBody.encoding)) {
        return {
          valid: false,
          reason: 'Invalid parameter: "encoding" must be String | Base58',
          status: 400
        }
      }
      if (!requestBody.encryptionType) {
        requestBody.encoding = 'ECIES'
      }
      if (!['AES', 'ECIES'].includes(requestBody.encryptionType)) {
        return {
          valid: false,
          reason: 'Invalid parameter: "encryptionType" must be AES | ECIES',
          status: 400
        }
      }
      return {
        valid: true
      }
    }
    return {
      valid: true
    }
  }
  return {
    valid: false,
    reason: `Invalid or unrecognized command: "${command}"`,
    status: 400
  }
}
