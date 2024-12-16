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
const connectionsData: RequestLimiter = {
  lastRequestTime: Date.now(),
  requester: '',
  numRequests: 0
}

// midleware to validate client addresses against a denylist
// it also checks the global rate limit
export const requestValidator = async function (req: Request, res: Response, next: any) {
  // Perform the validations.
  const requestIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress

  // grab request time
  const requestTime = Date.now()
  if (requestTime - connectionsData.lastRequestTime > CONNECTIONS_RATE_INTERVAL) {
    // last one was more than 1 minute ago? reset counter
    connectionsData.numRequests = 0
  }
  // always increment counter
  connectionsData.numRequests += 1
  // update time and requester information
  connectionsData.lastRequestTime = requestTime
  connectionsData.requester = requestIP

  const configuration = await getConfiguration()

  // check if IP is allowed or denied
  const ipValidation = await checkIP(requestIP, configuration)
  // Validation failed, or an error occurred during the external request.
  if (!ipValidation.valid) {
    res.status(403).send(ipValidation.error)
    return
  }
  // check global rate limits (not ip related)
  const requestRateValidation = checkConnectionsRateLimit(configuration, connectionsData)
  if (!requestRateValidation.valid) {
    res.status(403).send(requestRateValidation.error)
    return
  }
  // Validation passed.
  next()
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
