import { SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Command } from '../../@types/commands.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ReadableString } from '../P2P/handlers.js'

export type ValidateParams = {
  valid: boolean
  reason?: string
  status?: number
}

export function validateBroadcastParameters(requestBody: any): ValidateParams {
  // for now we can use the same validation function,
  // but later we might need to have separate validation functions
  // if we many different commands of each type
  return validateCommandParameters(requestBody, [])
}
// add others when we add suppor

// request level validation, just check if we have a "command" field and its a supported one
// each command handler is responsible for the reamining validatio of the command fields
export function validateCommandParameters(
  commandData: any,
  requiredFields: string[]
): ValidateParams {
  if (!commandData) {
    return buildInvalidRequestMessage('Missing request body/data')
  }

  const commandStr: string = commandData.command as string

  if (!commandStr) {
    return buildInvalidRequestMessage('Invalid Request: "command" is mandatory!')
  }
  // direct commands
  else if (!SUPPORTED_PROTOCOL_COMMANDS.includes(commandStr)) {
    return buildInvalidRequestMessage(`Invalid or unrecognized command: "${commandStr}"`)
  }

  if (commandStr === 'encrypt') {
    const encryptCommandData = commandData
    encryptCommandData.files = [] // hide files data for logging
    CORE_LOGGER.info(
      `Checking received command data for Command "${commandStr}": ${JSON.stringify(
        encryptCommandData,
        null,
        4
      )}`
    )
  } else {
    CORE_LOGGER.info(
      `Checking received command data for Command "${commandStr}": ${JSON.stringify(
        commandData,
        null,
        4
      )}`
    )
  }

  for (const field of requiredFields) {
    if (
      !Object.hasOwn(commandData as Command, field) ||
      commandData[field] === undefined ||
      commandData[field] === null
    ) {
      return {
        valid: false,
        status: 400,
        reason: `Missing one ( "${field}" ) or more required field(s) for command: "${commandStr}". Required fields: ${requiredFields}`
      }
    }
  }
  return {
    valid: true
  }
}

// aux function as we are repeating same block of code all the time, only thing that changes is reason msg
export function buildInvalidRequestMessage(cause: string): ValidateParams {
  return {
    valid: false,
    status: 400,
    reason: cause
  }
}

export function buildRateLimitReachedResponse(): P2PCommandResponse {
  return {
    stream: new ReadableString('Rate limit exceeded'),
    status: { httpStatus: 403, error: 'Rate limit exceeded' }
  }
}

// always send same response
export function buildInvalidParametersResponse(
  validation: ValidateParams
): P2PCommandResponse {
  return {
    stream: null,
    status: { httpStatus: validation.status, error: validation.reason }
  }
}

export function buildErrorResponse(cause: string): P2PCommandResponse {
  return {
    stream: null,
    status: {
      httpStatus: 400,
      error: `The result is not the expected one: ${cause}`
    }
  }
}
