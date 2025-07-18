import { Request, Response } from 'express'
import { getConfiguration } from '../../utils/config.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  checkGlobalConnectionsRateLimit,
  checkRequestsRateLimit,
  CommonValidation
} from '../../utils/validators.js'

// Middleware to validate IP and apply rate limiting
export const requestValidator = async function (req: Request, res: Response, next: any) {
  const now = Date.now()
  const requestIP = (req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    '') as string

  const configuration = await getConfiguration()

  const ipValidation = await checkIP(requestIP, configuration)
  if (!ipValidation.valid) {
    HTTP_LOGGER.logMessage(`IP denied: ${ipValidation.error}`)
    return res.status(403).send(ipValidation.error)
  }

  const rateLimitCheck = checkRequestsRateLimit(requestIP, configuration, now)
  if (!rateLimitCheck.valid) {
    HTTP_LOGGER.logMessage(
      `Exceeded limit of requests per minute ${configuration.rateLimit}: ${rateLimitCheck.error}`
    )
    return res.status(429).send(rateLimitCheck.error)
  }

  const connectionsRateValidation = checkGlobalConnectionsRateLimit(configuration, now)
  if (!connectionsRateValidation.valid) {
    res.status(403).send(connectionsRateValidation.error)
    return
  }

  next()
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
