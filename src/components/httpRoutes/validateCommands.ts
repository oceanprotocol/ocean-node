import { PROTOCOL_COMMANDS, SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Command } from '../../@types/commands.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { isDefined } from '../../utils/util.js'
import { ReadableString } from '../P2P/handlers.js'

export type ValidateParams = {
  valid: boolean
  reason?: string
  status?: number
}

// credentials present on (almost) any command. these must never reach the logs, on any
// command, since they are what authorizes the request in the first place
const SENSITIVE_COMMAND_FIELDS = [
  'authorization', // auth token (JWT), usually taken from the Authorization header
  'signature', // consumer signature authorizing this command
  'aes_encrypted_key', // download: encrypted key material
  'encryptedDockerRegistryAuth' // compute: encrypted docker registry credentials
]

// "token" is an ERC20 address on most commands (escrow, compute payment) and only a
// credential on the auth-token commands, so it is redacted per-command instead
const SENSITIVE_TOKEN_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN,
  PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN
]

const REDACTED = '[REDACTED]'

/**
 * Returns a copy of the payload with every credential field redacted, at any depth.
 *
 * This must not mutate its input: the clone the caller hands us can be a *shallow* copy
 * (the fallback path below), so nested objects are still shared with the real command and
 * the handlers still need the actual credentials. So we rebuild containers instead of
 * writing into them.
 *
 * Only plain objects and arrays are walked - Buffers, typed arrays, Dates, streams and the
 * like are passed through untouched.
 */
function redactSensitiveFields(
  value: any,
  redactToken: boolean,
  seen: WeakSet<object>
): any {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[CIRCULAR]'
  }
  if (Array.isArray(value)) {
    seen.add(value)
    const copy = value.map((item) => redactSensitiveFields(item, redactToken, seen))
    seen.delete(value)
    return copy
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    return value
  }
  seen.add(value)
  const copy: any = {}
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_COMMAND_FIELDS.includes(key) || (redactToken && key === 'token')) {
      copy[key] = isDefined(item) ? REDACTED : item
    } else {
      copy[key] = redactSensitiveFields(item, redactToken, seen)
    }
  }
  seen.delete(value)
  return copy
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
  logCommandData = redactSensitiveFields(
    logCommandData,
    SENSITIVE_TOKEN_COMMANDS.includes(commandStr),
    new WeakSet()
  )

  CORE_LOGGER.info(
    `Checking received command data for Command "${commandStr}": ${JSON.stringify(
      logCommandData,
      null,
      4
    )}`
  )

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
