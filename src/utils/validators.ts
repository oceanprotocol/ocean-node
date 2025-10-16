import { ConsumerParameter } from '../@types/DDO/ConsumerParameter.js'
import { OceanNodeConfig } from '../@types/OceanNode.js'
import { ValidateParams } from '../components/httpRoutes/validateCommands.js'
import { RequestLimiter } from '../OceanNode.js'
import { CORE_LOGGER } from './logging/common.js'
import { CONNECTIONS_RATE_INTERVAL } from './constants.js'
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

export function checkRequestsRateLimit(
  requestIP: string,
  configuration: OceanNodeConfig,
  now: number
): CommonValidation {
  const limit = configuration.rateLimit
  let clientData = connectionsData.get(requestIP)

  if (!clientData || clientData === undefined) {
    clientData = {
      lastRequestTime: now,
      requester: requestIP,
      numRequests: 1
    }
    connectionsData.set(requestIP, clientData)
    return { valid: true, error: '' }
  }

  const timeSinceLastRequest = now - clientData.lastRequestTime
  const windowExpired = timeSinceLastRequest > CONNECTIONS_RATE_INTERVAL

  if (clientData.numRequests >= limit && !windowExpired) {
    const waitTime = Math.ceil((CONNECTIONS_RATE_INTERVAL - timeSinceLastRequest) / 1000)
    return {
      valid: false,
      error: `Rate limit exceeded. Try again in ${waitTime} seconds.`
    }
  }

  if (windowExpired) {
    clientData.numRequests = 1
    clientData.lastRequestTime = now
    return { valid: true, error: '' }
  }

  clientData.numRequests += 1
  return { valid: true, error: '' }
}

export function checkGlobalConnectionsRateLimit(
  configuration: OceanNodeConfig,
  now: number
): CommonValidation {
  const maxConnections =
    configuration.maxConnections || DEFAULT_MAX_CONNECTIONS_PER_MINUTE
  let activeRequesters = 0

  for (const [, clientData] of connectionsData.entries()) {
    if (now - clientData.lastRequestTime <= CONNECTIONS_RATE_INTERVAL) {
      activeRequesters += 1
    }
  }
  const valid = activeRequesters <= maxConnections

  return {
    valid,
    error: valid
      ? ''
      : `Too many active connections (${activeRequesters}/${maxConnections}) in the last minute.`
  }
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
    CORE_LOGGER.error(error.message)
    validation.valid = false
    validation.reason = error.message
    validation.status = 400
    return validation
  }
}
