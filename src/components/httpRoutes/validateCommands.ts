import {
  SUPPORTED_PROTOCOL_COMMANDS,
  DIRECT_COMMANDS,
  BROADCAST_COMMANDS
} from '../../utils/constants.js'

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
    if (command === DIRECT_COMMANDS.DOWNLOAD_URL) {
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
    } else if (command === DIRECT_COMMANDS.ECHO) {
      // nothing special with this one
      return {
        valid: true
      }
      // broadcast commands
    } else if (command === BROADCAST_COMMANDS.FIND_DDO) {
      // message is DDO identifier
      if (!requestBody.message || !requestBody.message.startsWith('did:op')) {
        return {
          valid: false,
          reason: 'Missing or invalid required parameter: "message"',
          status: 400
        }
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
