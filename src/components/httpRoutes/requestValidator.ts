import { Request, Response } from 'express'
import { getConfiguration } from '../../utils'

// TODO we should group common stuff,
// we have multiple similar validation interfaces
export interface CommonValidation {
  valid: boolean
  error?: string
}
const configuration = await getConfiguration()
// midleware to valid client addresses against a blacklist
export const requestValidator = function (req: Request, res: Response, next: any) {
  // Perform your validations.
  console.log(req.headers['x-forwarded-for'])
  console.log(req.socket.remoteAddress)
  const requestIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress

  const validation = check(requestIP)
  // Validation failed, or an error occurred during the external request.
  if (!validation.valid) {
    res.status(403).send(validation.error)
    return
  }
  // Validation passed.
  next()
}

function check(requestIP: string | string[]): CommonValidation {
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

  return {
    valid: !isBlackListed,
    error: isBlackListed
      ? `An unauthorized IP address ${requestIP} has tried to access the service`
      : ''
  }
}
