import { Request, Response } from 'express'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../utils/logging/Logger.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  checkGlobalConnectionsRateLimit,
  checkRequestsRateLimit,
  recordAcceptedRequest,
  CommonValidation
} from '../../utils/validators.js'

const RATE_LIMIT_LOG_INTERVAL_MS = 60_000

// Middleware to validate IP and apply rate limiting
export const requestValidator = async function (req: Request, res: Response, next: any) {
  const now = Date.now()
  // req.ip honours the Express `trust proxy` setting, which is configured from
  // config.trustProxy in index.ts. With it off (the default) req.ip is the real socket
  // peer and the client-supplied X-Forwarded-For header is ignored; with trusted proxies
  // declared, Express returns the first hop that is not itself a trusted proxy. Either way
  // the value is NOT freely client-spoofable, so it is safe to use as the rate-limit and
  // deny-list key. Reading the raw X-Forwarded-For header here let any client rotate the
  // header to dodge the per-IP limit and inflate the global cap into a node-wide DoS.
  const requestIP = (req.ip || req.socket.remoteAddress || '') as string

  const configuration = req.oceanNode.getConfig()

  const ipValidation = await checkIP(requestIP, configuration)
  if (!ipValidation.valid) {
    HTTP_LOGGER.debug(`Request denied: IP ${requestIP} is on the deny list`)
    return res.status(403).send(ipValidation.error)
  }

  const rateLimitCheck = checkRequestsRateLimit(requestIP, configuration, now)
  if (!rateLimitCheck.valid) {
    HTTP_LOGGER.throttled(
      'http-rate-limit',
      LOG_LEVELS_STR.LEVEL_WARN,
      `Rate limit exceeded for ${requestIP} (${configuration.rateLimit}/min)`,
      RATE_LIMIT_LOG_INTERVAL_MS
    )
    return res.status(429).send(rateLimitCheck.error)
  }

  const connectionsRateValidation = checkGlobalConnectionsRateLimit(configuration, now)
  if (!connectionsRateValidation.valid) {
    HTTP_LOGGER.throttled(
      'http-connections-limit',
      LOG_LEVELS_STR.LEVEL_WARN,
      connectionsRateValidation.error,
      RATE_LIMIT_LOG_INTERVAL_MS
    )
    res.status(403).send(connectionsRateValidation.error)
    return
  }

  // Admitted by both limits: record it now so only accepted requests consume capacity.
  recordAcceptedRequest(requestIP, now)
  next()
}

function checkIP(
  requestIP: string | string[],
  configuration: OceanNodeConfig
): CommonValidation {
  let onDenyList = false
  if (!Array.isArray(requestIP)) {
    onDenyList = configuration.denyList?.ips?.includes(requestIP)
  } else {
    for (const ip of requestIP) {
      if (configuration.denyList?.ips?.includes(ip)) {
        onDenyList = true
        break
      }
    }
  }

  return {
    valid: !onDenyList,
    error: onDenyList ? 'Unauthorized request' : ''
  }
}
