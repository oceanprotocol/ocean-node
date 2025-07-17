import { Request, Response } from 'express'
import { getConfiguration } from '../../utils/config.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { RequestLimiter } from '../../OceanNode.js'
import {
  CONNECTIONS_RATE_INTERVAL,
  DEFAULT_MAX_CONNECTIONS_PER_MINUTE
} from '../../utils/constants.js'

// TODO we should group common stuff,
// we have multiple similar validation interfaces
export interface CommonValidation {
  valid: boolean
  error?: string
}

// hold data about last request made
const connectionsData = new Map<string, RequestLimiter>()

// Middleware to validate IP and apply rate limiting
export const requestValidator = async function (req: Request, res: Response, next: any) {
  const requestIP = (req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    '') as string

  const configuration = await getConfiguration()

  const ipValidation = await checkIP(requestIP, configuration)
  if (!ipValidation.valid) {
    HTTP_LOGGER.logMessage(`IP denied: ${ipValidation.error}`)
    return res.status(403).send(ipValidation.error)
  }

  const rateLimitCheck = checkRequestsRateLimit(requestIP, configuration)
  if (!rateLimitCheck.valid) {
    HTTP_LOGGER.logMessage(
      `Exceeded limit of requests per minute ${configuration.rateLimit}: ${rateLimitCheck.error}`
    )
    return res.status(429).send(rateLimitCheck.error)
  }

  const requestRateValidation = checkConnectionsRateLimit(
    configuration,
    connectionsData.get(requestIP)
  )
  if (!requestRateValidation.valid) {
    HTTP_LOGGER.logMessage(
      `Exceeded limit of connections per minute ${configuration.maxConnections}: ${requestRateValidation.error}`
    )
    res.status(403).send(requestRateValidation.error)
    return
  }

  next()
}

function checkRequestsRateLimit(
  requestIP: string,
  configuration: OceanNodeConfig
): CommonValidation {
  const requestTime = Date.now()
  const limit = configuration.rateLimit
  let clientData = connectionsData.get(requestIP)

  if (!clientData || clientData === undefined) {
    clientData = {
      lastRequestTime: requestTime,
      requester: requestIP,
      numRequests: 1
    }
    connectionsData.set(requestIP, clientData)
    return { valid: true, error: '' }
  }

  const timeSinceLastRequest = requestTime - clientData.lastRequestTime
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
    clientData.lastRequestTime = requestTime
    return { valid: true, error: '' }
  }

  clientData.numRequests += 1
  return { valid: true, error: '' }
}

export function checkConnectionsRateLimit(
  configuration: OceanNodeConfig,
  connectionsData: RequestLimiter
): CommonValidation {
  const connectionLimits =
    configuration.maxConnections || DEFAULT_MAX_CONNECTIONS_PER_MINUTE
  const ok = connectionsData.numRequests <= connectionLimits
  return {
    valid: ok,
    error: ok ? '' : 'Unauthorized request. Rate limit exceeded!'
  }
}

function checkIP(
  requestIP: string | string[],
  configuration: OceanNodeConfig
): CommonValidation {
  let onDenyList = false
  if (!Array.isArray(requestIP)) {
    onDenyList = configuration.denyList?.ips.includes(requestIP)
  } else {
    for (const ip of requestIP) {
      if (configuration.denyList?.ips.includes(ip)) {
        onDenyList = true
        break
      }
    }
  }

  if (onDenyList) {
    HTTP_LOGGER.error(`Incoming request denied to ip address: ${requestIP}`)
  }

  return {
    valid: !onDenyList,
    error: onDenyList ? 'Unauthorized request' : ''
  }
}
