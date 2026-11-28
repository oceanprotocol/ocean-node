import { PROTOCOL_COMMANDS, SUPPORTED_PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'
import { Command, ServicePortRequest } from '../../@types/commands.js'
import { MAX_SERVICE_PORTS } from '../../@types/C2D/ServiceOnDemand.js'
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
// credential on the auth-token commands and the policy-server passthrough (whose free-form
// blob can carry a policy-server auth token), so it is redacted per-command instead
const SENSITIVE_TOKEN_COMMANDS: string[] = [
  PROTOCOL_COMMANDS.INVALIDATE_AUTH_TOKEN,
  PROTOCOL_COMMANDS.VALIDATE_AUTH_TOKEN,
  PROTOCOL_COMMANDS.POLICY_SERVER_PASSTHROUGH
]

const REDACTED = '[REDACTED]'

/**
 * Returns a copy of a command that is safe to log: non-cloneable fields (streams, buffers)
 * are summarized and every credential field is redacted, at any depth (see
 * utils/logging/redact.ts: sensitive keys are matched case-insensitively and URLs in any
 * string are reduced to their origin). Use this anywhere a command payload is about to be
 * logged, so that credentials never reach the logs through a path that skips
 * validateCommandParameters.
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
    if (logCommandData.blob !== undefined && logCommandData.blob !== null) {
      logCommandData.blob = REDACTED // the plaintext the caller wants encrypted
    }
  } else if (commandStr === PROTOCOL_COMMANDS.ENCRYPT_FILE && commandData.rawData) {
    logCommandData.rawData = []
  }

  // never log the caller's credentials, whatever the command is. credentials also show up
  // nested (the free-form "policyServer" / "policyServerPassthrough" blobs, dataset file
  // objects), so this walks the whole payload
  return redactSensitiveFields(logCommandData, {
    redactToken: SENSITIVE_TOKEN_COMMANDS.includes(commandStr)
  })
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

  // the dump is only built when some transport takes debug lines: cloning and redacting
  // every command (rawData buffers included) is not free
  if (CORE_LOGGER.isLevelEnabled(LOG_LEVELS_STR.LEVEL_DEBUG)) {
    CORE_LOGGER.debug(
      `Checking received command data for Command "${commandStr}": ${JSON.stringify(
        redactCommandForLogging(commandData)
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

// Hard cap on how many ports a single service command may declare (applies to both the `ports`
// pair form and the legacy `exposedPorts`). No legitimate service needs anywhere near this many,
// and it is well under the default hostPortRange size (2768): without it, a single 4 MB
// /directCommand or P2P body could carry hundreds of thousands of entries, forcing a pre-escrow
// isPortFree() syscall storm (pinned) or an escrow charge followed by host-port-range exhaustion
// at CONTINUE (unpinned → charge-without-service). Rejected up front as a 400.
// Defined in @types (dependency-free) so the c2d engine can advertise it without importing this
// module (which would risk an import cycle); re-exported here so existing importers keep working.
export { MAX_SERVICE_PORTS }

// Structural validation of the service `ports` field (shared by the service start/restart
// handlers). Range membership + OS freeness of a pinned host port are enforced later, by the
// engine's reserveSpecificHostPort (which knows the daemon's hostPortRange). Returns null when
// the spec is well formed, else a 400 ValidateParams.
export function validatePortSpecStructure(
  ports: ServicePortRequest[]
): ValidateParams | null {
  if (!Array.isArray(ports) || ports.length === 0)
    return buildInvalidRequestMessage('"ports" must be a non-empty array')
  if (ports.length > MAX_SERVICE_PORTS)
    return buildInvalidRequestMessage(
      `"ports" may contain at most ${MAX_SERVICE_PORTS} entries`
    )
  const seenContainer = new Set<number>()
  const seenHost = new Set<number>()
  for (const p of ports) {
    if (
      !p ||
      !Number.isInteger(p.containerPort) ||
      p.containerPort < 1 ||
      p.containerPort > 65535
    )
      return buildInvalidRequestMessage(
        'each entry in "ports" needs an integer containerPort in 1..65535'
      )
    if (seenContainer.has(p.containerPort))
      return buildInvalidRequestMessage(
        `duplicate containerPort ${p.containerPort} in "ports"`
      )
    seenContainer.add(p.containerPort)
    if (p.hostPort !== undefined) {
      if (!Number.isInteger(p.hostPort) || p.hostPort < 1 || p.hostPort > 65535)
        return buildInvalidRequestMessage('hostPort must be an integer in 1..65535')
      if (seenHost.has(p.hostPort))
        return buildInvalidRequestMessage(`duplicate hostPort ${p.hostPort} in "ports"`)
      seenHost.add(p.hostPort)
    }
  }
  return null
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
