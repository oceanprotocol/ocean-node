import { Request, Response } from 'express'
import { getConfiguration } from '../../utils/index.js'
import { HTTP_LOGGER } from '../../utils/logging/common.js'

// TODO we should group common stuff,
// we have multiple similar validation interfaces
export interface CommonValidation {
  valid: boolean
  error?: string
}

// midleware to valid client addresses against a denylist
export const requestValidator = async function (req: Request, res: Response, next: any) {
  // Perform the validations.
  const requestIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const validation = await checkIP(requestIP)
  // Validation failed, or an error occurred during the external request.
  if (!validation.valid) {
    res.status(403).send(validation.error)
    return
  }
  // Validation passed.
  next()
}

async function checkIP(requestIP: string | string[]): Promise<CommonValidation> {
  let onDenyList = false
  const configuration = await getConfiguration()
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
