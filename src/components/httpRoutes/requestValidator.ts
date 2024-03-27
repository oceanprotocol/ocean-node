import { Request, Response } from 'express'
import { getConfiguration } from '../../utils'
import { HTTP_LOGGER } from '../../utils/logging/common'

// TODO we should group common stuff,
// we have multiple similar validation interfaces
export interface CommonValidation {
  valid: boolean
  error?: string
}
const configuration = await getConfiguration()
// midleware to valid client addresses against a blacklist
export const requestValidator = function (req: Request, res: Response, next: any) {
  // Perform the validations.
  const requestIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const validation = checkIP(requestIP)
  // Validation failed, or an error occurred during the external request.
  if (!validation.valid) {
    res.status(403).send(validation.error)
    return
  }
  // Validation passed.
  next()
}

function checkIP(requestIP: string | string[]): CommonValidation {
  let isBlackListed = false
  if (!Array.isArray(requestIP)) {
    isBlackListed = configuration.blackList?.ips.includes(requestIP)
  } else {
    for (const ip of requestIP) {
      if (configuration.blackList?.ips.includes(ip)) {
        isBlackListed = true
        break
      }
    }
  }

  if (isBlackListed) {
    HTTP_LOGGER.error(`Incoming request denied to blacklisted ip address: ${requestIP}`)
  }

  return {
    valid: !isBlackListed,
    error: isBlackListed ? 'Unauthorized request' : ''
  }
}
