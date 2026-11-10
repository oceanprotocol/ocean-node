import { ConsumerParameter } from '../@types/DDO/ConsumerParameter.js'
import { OceanNodeConfig } from '../@types/OceanNode.js'
import { ValidateParams } from '../components/httpRoutes/validateCommands.js'
import { RequestLimiter } from '../OceanNode.js'
import { CORE_LOGGER } from './logging/common.js'
import {
  CONNECTIONS_RATE_INTERVAL,
  CONNECTION_HISTORY_DELETE_THRESHOLD
} from './constants.js'
import { DEFAULT_MAX_CONNECTIONS_PER_MINUTE } from './index.js'

// TODO we should group common stuff,
// we have multiple similar validation interfaces
export interface CommonValidation {
  valid: boolean
  error?: string
}

// hold data about last request made
const connectionsData = new Map<string, RequestLimiter>()

function checkString(value: any) {
  return typeof value === 'string' || value instanceof String
}

function checkBoolean(value: any) {
  return typeof value === 'boolean' || value instanceof Boolean
}

function checkNumber(value: any) {
  return typeof value === 'number' || value instanceof Number
}

function checkObject(value: any) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The rate limiters follow a peek-then-commit model: checkRequestsRateLimit and
// checkGlobalConnectionsRateLimit only READ state, and recordAcceptedRequest is called once a
// request has cleared BOTH checks. A rejected request is therefore never recorded, so it can
// neither consume a per-IP slot nor count toward the global total. Recording on every attempt
// (the previous behaviour) let rejected requests keep the global count pinned at the cap long
// after the accepted traffic drained, turning a brief overload into a self-sustaining outage.
//
// The node-wide ceiling is a single global fixed-window counter keyed by the actual time each
// request was admitted — NOT a sum of each client's per-IP counter. Summing per-IP counters
// tied every request's lifetime to its client's window start, so a whole client's count popped
// in and out of the total when that client's window rolled over, mis-counting requests made
// near a window boundary. One global window counts admitted requests by when they happened.
// Both front doors (HTTP requestValidator and P2P handleProtocolCommands) share this counter.
let globalWindowStart = 0
let globalAcceptedCount = 0

export function checkRequestsRateLimit(
  requestIP: string,
  configuration: OceanNodeConfig,
  now: number
): CommonValidation {
  const limit = configuration.rateLimit
  const clientData = connectionsData.get(requestIP)

  // No history, or the previous window has elapsed: this request is within the per-IP limit.
  if (!clientData) {
    return { valid: true, error: '' }
  }

  const timeSinceLastRequest = now - clientData.lastRequestTime
  const windowExpired = timeSinceLastRequest > CONNECTIONS_RATE_INTERVAL
  if (windowExpired) {
    return { valid: true, error: '' }
  }

  if (clientData.numRequests >= limit) {
    const waitTime = Math.ceil((CONNECTIONS_RATE_INTERVAL - timeSinceLastRequest) / 1000)
    return {
      valid: false,
      error: `Rate limit exceeded. Try again in ${waitTime} seconds.`
    }
  }

  return { valid: true, error: '' }
}

export function checkGlobalConnectionsRateLimit(
  configuration: OceanNodeConfig,
  now: number
): CommonValidation {
  const maxConnections =
    configuration.maxConnections || DEFAULT_MAX_CONNECTIONS_PER_MINUTE

  // Global accepted requests within the current fixed window. If the window has elapsed, nothing
  // is counted yet (recordAcceptedRequest will open a fresh one). Admit only when there is room
  // for one more; since only accepted requests are recorded, this never reflects rejected ones.
  // This is a pure read — stale per-IP entries are pruned in recordAcceptedRequest on rollover,
  // not here, so a peek does not pay an O(n) scan on every request.
  const windowActive = now - globalWindowStart <= CONNECTIONS_RATE_INTERVAL
  const used = windowActive ? globalAcceptedCount : 0
  const valid = used < maxConnections

  return {
    valid,
    error: valid
      ? ''
      : `Too many requests (${used}/${maxConnections}) in the last minute.`
  }
}

// Record an ACCEPTED request against both its per-IP counter and the global window counter. Must
// be called exactly once, and only after both checkRequestsRateLimit and
// checkGlobalConnectionsRateLimit have passed.
export function recordAcceptedRequest(requestIP: string, now: number): void {
  const clientData = connectionsData.get(requestIP)

  // Per-IP window: new client, or the previous window elapsed, starts a fresh window at 1.
  if (!clientData || now - clientData.lastRequestTime > CONNECTIONS_RATE_INTERVAL) {
    connectionsData.set(requestIP, {
      lastRequestTime: now,
      requester: requestIP,
      numRequests: 1
    })
  } else {
    clientData.numRequests += 1
  }

  // Global fixed window: reset when the previous one has elapsed, then count this request. The
  // rollover is also the moment we prune stale per-IP entries, so the map stays bounded without
  // paying an O(n) scan on every request (it runs at most once per window under load).
  if (now - globalWindowStart > CONNECTIONS_RATE_INTERVAL) {
    globalWindowStart = now
    globalAcceptedCount = 0
    for (const [key, data] of connectionsData.entries()) {
      if (now - data.lastRequestTime > CONNECTIONS_RATE_INTERVAL) {
        connectionsData.delete(key)
      }
    }
  }
  globalAcceptedCount += 1

  // Hard cap (defense-in-depth): keep the per-IP map bounded even between window rollovers.
  // Keys here are un-spoofable (req.ip), so this is secondary to the pruning above, but it
  // guarantees the map can never grow without bound. Evict the LEAST-ACTIVE entries first
  // (lowest request count, ties broken by oldest window start), mirroring the handler-level
  // limiter: a flood of singleton callers is dropped before an actively rate-limited caller, so
  // the flood cannot reset a victim's counter. O(n) only when at/over the cap.
  if (connectionsData.size > CONNECTION_HISTORY_DELETE_THRESHOLD) {
    const byLeastActive = [...connectionsData.entries()].sort(
      (a, b) =>
        a[1].numRequests - b[1].numRequests || a[1].lastRequestTime - b[1].lastRequestTime
    )
    const removeCount = connectionsData.size - CONNECTION_HISTORY_DELETE_THRESHOLD
    for (let i = 0; i < removeCount && i < byLeastActive.length; i++) {
      connectionsData.delete(byLeastActive[i][0])
    }
  }
}

// Test-only helper: clear ALL shared rate-limiter state — the per-IP map and the global window
// counter — so a test starts from an empty limiter regardless of what earlier suites recorded.
// The global counter is a single process-wide bucket that unique IPs and spaced timestamps do
// not isolate (a real Date.now() recorded by an earlier suite sits far in the future relative to
// a small fixed test timestamp, so the window never looks expired). Not used in production code.
export function resetRateLimiterState(): void {
  connectionsData.clear()
  globalWindowStart = 0
  globalAcceptedCount = 0
}

// Test-only helper: current number of per-IP entries, so a test can assert the hard cap bounds
// the map under a flood of distinct IPs. Not used in production code.
export function connectionsDataSize(): number {
  return connectionsData.size
}

export function validateConsumerParameters(
  ddoConsumerParameters: ConsumerParameter | ConsumerParameter[],
  userSentObject: any | any[]
): ValidateParams {
  const validation: ValidateParams = {
    valid: true,
    reason: '',
    status: 200
  }

  try {
    if (!Array.isArray(userSentObject)) {
      userSentObject = [userSentObject]
    }
    if (!Array.isArray(ddoConsumerParameters)) {
      ddoConsumerParameters = [ddoConsumerParameters]
    }

    for (const consumerParameter of ddoConsumerParameters) {
      for (const sentObject of userSentObject) {
        if (!checkObject(sentObject)) {
          throw new Error(`Value is not an object`)
        }
        // check if key exists in object and if it is required or not, if not add default value
        const sentObjectKey = consumerParameter.name
        if (
          sentObject[sentObjectKey] === undefined ||
          sentObject[sentObjectKey] === null
        ) {
          if (consumerParameter.required) {
            throw new Error(`value of key ${sentObjectKey} parameter is required`)
          }
          sentObject[sentObjectKey] = consumerParameter.default
        }
        // check the value for that key
        const sentObjectValue = sentObject[sentObjectKey]
        const parameterType = consumerParameter.type // text, number, boolean or select
        let hasWrongType = false
        if (
          (parameterType === 'text' && !checkString(sentObjectValue)) ||
          (parameterType === 'number' && !checkNumber(sentObjectValue)) ||
          (parameterType === 'boolean' && !checkBoolean(sentObjectValue))
        ) {
          hasWrongType = true
        } else if (parameterType === 'select') {
          const options: any[] = consumerParameter.options.map(
            (option) => Object.keys(option)[0]
          )
          if (!options.includes(sentObjectValue)) {
            hasWrongType = true
          }
        }
        if (hasWrongType) {
          throw new Error(
            `value ${sentObjectValue} of key ${sentObjectKey} parameter has wrong type, expected: "${parameterType}", got: "${typeof sentObjectValue}`
          )
        }
      }
    }
    return validation
  } catch (error) {
    CORE_LOGGER.error(`Invalid consumer parameters: ${error.message}`)
    validation.valid = false
    validation.reason = error.message
    validation.status = 400
    return validation
  }
}
