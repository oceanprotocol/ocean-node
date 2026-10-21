import { PROTOCOL_COMMANDS, SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Command } from '../../@types/commands.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { redactSensitiveFields } from '../../utils/logging/redact.js'
import { ReadableString } from '../P2P/handlers.js'

export type ValidateParams = {
  valid: boolean
  reason?: string
  status?: number
}

// "token" is an ERC20 address on most commands (escrow, compute payment) and only a
// credential on the auth-token commands, so it is redacted per-command instead
const SENSITIVE_TOKEN_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN,
  PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN
]

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

  // the dump is only built when some transport takes debug lines: cloning and redacting
  // every command (rawData buffers included) is not free
  if (CORE_LOGGER.isLevelEnabled(LOG_LEVELS_STR.LEVEL_DEBUG)) {
    // deep copy for logging (must not throw for non-cloneable payloads like streams)
    let logCommandData: any
    try {
      // For some commands, the task contains non-cloneable fields (e.g. Node streams).
      // We redact those before cloning to avoid DataCloneError.
      const sanitized = { ...(commandData ?? {}) }
      if ('stream' in sanitized) {
        sanitized.stream = '[STREAM]'
      }
      logCommandData = structuredClone(sanitized)
    } catch {
      // Last resort: shallow clone; avoid crashing validation because of logging.
      logCommandData = { ...(commandData ?? {}) }
      if ('stream' in logCommandData) {
        logCommandData.stream = '[STREAM]'
      }
    }

    if (commandStr === PROTOCOL_COMMANDS.ENCRYPT) {
      logCommandData.files = [] // hide files data (sensitive) + rawData (long buffer) from logging
    } else if (commandStr === PROTOCOL_COMMANDS.ENCRYPT_FILE && commandData.rawData) {
      logCommandData.rawData = []
    }

    // never log the caller's credentials, whatever the command is. credentials also show up
    // nested (the free-form "policyServer" / "policyServerPassthrough" blobs), so this walks
    // the whole payload
    logCommandData = redactSensitiveFields(logCommandData, {
      redactToken: SENSITIVE_TOKEN_COMMANDS.includes(commandStr)
    })

    CORE_LOGGER.debug(
      `Checking received command data for Command "${commandStr}": ${JSON.stringify(
        logCommandData
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
