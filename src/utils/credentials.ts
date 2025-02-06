import { Credential, Credentials } from '../@types/DDO/Credentials'
import { PROVIDER_LOGGER } from './logging/common'

export function findCredential(
  credentials: Credential[],
  consumerCredentials: Credential
) {
  return credentials.find((credential) => {
    if (Array.isArray(credential?.values)) {
      if (credential.values.length > 0) {
        const credentialType = String(credential?.type)?.toLowerCase()
        const credentialValues = credential.values.map((v) => String(v)?.toLowerCase())
        return (
          credentialType === consumerCredentials.type &&
          credentialValues.includes(consumerCredentials.values[0])
        )
      }
    }
    return false
  })
}

/**
 * This method checks credentials
 * @param credentials credentials
 * @param consumerAddress consumer address
 */
export function checkCredentials(credentials: Credentials, consumerAddress: string) {
  PROVIDER_LOGGER.logMessage(`check credentials started!`)
  const consumerCredentials = {
    type: 'address',
    values: [String(consumerAddress)?.toLowerCase()]
  }
  PROVIDER_LOGGER.logMessage(
    `consumerCredentials: ${JSON.stringify(consumerCredentials)}`
  )
  PROVIDER_LOGGER.logMessage(`credentials: ${JSON.stringify(credentials)}`)
  // check deny access
  if (Array.isArray(credentials?.deny) && credentials.deny.length > 0) {
    const accessDeny = findCredential(credentials.deny, consumerCredentials)
    if (accessDeny) {
      return false
    }
  }
  // check allow access
  if (Array.isArray(credentials?.allow) && credentials.allow.length > 0) {
    const accessAllow = findCredential(credentials.allow, consumerCredentials)
    if (!accessAllow) {
      return false
    }
  }
  return true
}
