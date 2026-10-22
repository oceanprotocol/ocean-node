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
  'encryptedDockerRegistryAuth', // compute: encrypted docker registry credentials
  'headers', // file objects: per-request headers, often carry an Authorization token
  'accessKeyId', // s3 file objects: access key id
  'secretAccessKey', // s3 file objects: secret access key
  'rawcode' // compute: algorithm.meta.rawcode, the raw algorithm source (may embed secrets)
]

// lower-cased once so field names can be matched case-insensitively: credentials nested in
// the free-form policyServer / policyServerPassthrough blobs can arrive under any casing
// (e.g. "Authorization", "AccessKeyId"), and the exact-case check used to let those through
const SENSITIVE_COMMAND_FIELDS_LOWER = SENSITIVE_COMMAND_FIELDS.map((field) =>
  field.toLowerCase()
)

// "token" is an ERC20 address on most commands (escrow, compute payment) and only a
// credential on the auth-token commands and the policy-server passthrough (whose free-form
// blob can carry a policy-server auth token), so it is redacted per-command instead
const SENSITIVE_TOKEN_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN,
  PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN,
  PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH
]

const REDACTED = '[REDACTED]'

/**
 * Strips credentials and query strings from a URL-looking string before it reaches the logs.
 * File objects carry URLs as plain string values (not under a redacted key): an FtpFileObject
 * `url` can embed `user:password@host` (see FtpFileObject) and an http(s) URL can carry a
 * presigned token in the query string. Those would otherwise survive the key-based redaction
 * below and be logged in full. Non-URL strings (DIDs, addresses, multiaddrs, ...) are returned
 * unchanged.
 */
function stripUrlSecrets(value: string): string {
  if (!value.includes('://')) {
    return value
  }
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    return url.toString()
  } catch {
    return value
  }
}

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
    return typeof value === 'string' ? stripUrlSecrets(value) : value
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
    const keyLower = key.toLowerCase()
    if (
      SENSITIVE_COMMAND_FIELDS_LOWER.includes(keyLower) ||
      (redactToken && keyLower === 'token')
    ) {
      copy[key] = isDefined(item) ? REDACTED : item
    } else {
      copy[key] = redactSensitiveFields(item, redactToken, seen)
    }
  }
  seen.delete(value)
  return copy
}

// add others when we add suppor

/**
 * Returns a copy of a command that is safe to log: non-cloneable fields (streams, buffers)
 * are summarized and every credential field is redacted, at any depth. Use this anywhere a
 * command payload is about to be logged - HTTP routes, the P2P inbound/outbound paths - so
 * that credentials never reach the logs through a path that skips validateCommandParameters.
 */
export function redactCommandForLogging(commandData: any): any {
  const commandStr: string = commandData?.command as string

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
    if (isDefined(logCommandData.blob)) {
      logCommandData.blob = REDACTED // the plaintext the caller wants encrypted
    }
  } else if (commandStr === PROTOCOL_COMMANDS.ENCRYPT_FILE && commandData.rawData) {
    logCommandData.rawData = []
  }

  // never log the caller's credentials, whatever the command is. credentials also show up
  // nested (the free-form "policyServer" / "policyServerPassthrough" blobs, dataset file
  // objects), so this walks the whole payload
  return redactSensitiveFields(
    logCommandData,
    SENSITIVE_TOKEN_COMMANDS.includes(commandStr),
    new WeakSet()
  )
}

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

  const logCommandData = redactCommandForLogging(commandData)

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
