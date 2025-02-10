import {
  Credential,
  Credentials,
  KNOWN_CREDENTIALS_TYPES
} from '../@types/DDO/Credentials.js'
import { isDefined } from './util.js'

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

export function hasAddressMatchAllRule(credentials: Credential[]): boolean {
  const creds = credentials.find((credential: Credential) => {
    if (Array.isArray(credential?.values)) {
      if (credential.values.length > 0 && credential.type) {
        const filteredValues: string[] = credential.values.filter((value: string) => {
          return value?.toLowerCase() === '*' // address
        })
        return (
          filteredValues.length > 0 &&
          credential.type.toLowerCase() === KNOWN_CREDENTIALS_TYPES[0]
        )
      }
    }
    return false
  })
  return isDefined(creds)
}

/**
 * This method checks credentials
 * @param credentials credentials
 * @param consumerAddress consumer address
 */
export function checkCredentials(credentials: Credentials, consumerAddress: string) {
  const consumerCredentials = {
    type: 'address',
    values: [String(consumerAddress)?.toLowerCase()]
  }

  const accessGranted = true
  // check deny access
  if (Array.isArray(credentials?.deny) && credentials.deny.length > 0) {
    const accessDeny = findCredential(credentials.deny, consumerCredentials)
    // credential is on deny list, so it should be blocked access
    if (accessDeny) {
      return false
    }
    // credential not found, so it really depends if we have a match
  }
  // check allow access
  if (Array.isArray(credentials?.allow) && credentials.allow.length > 0) {
    const accessAllow = findCredential(credentials.allow, consumerCredentials)
    if (accessAllow || hasAddressMatchAllRule(credentials.allow)) {
      return true
    }
    return false
  }
  return accessGranted
}

export function areKnownCredentialTypes(credentials: Credentials): boolean {
  let known = true
  if (isDefined(credentials)) {
    if (isDefined(credentials.allow) && credentials.allow.length > 0) {
      for (const credential of credentials.allow) {
        if (!KNOWN_CREDENTIALS_TYPES.includes(credential.type)) {
          known = false
          break
        }
      }
    }

    if (isDefined(credentials.deny) && credentials.deny.length > 0) {
      for (const credential of credentials.deny) {
        if (!KNOWN_CREDENTIALS_TYPES.includes(credential.type)) {
          known = false
          break
        }
      }
    }
  }
  return known
}
