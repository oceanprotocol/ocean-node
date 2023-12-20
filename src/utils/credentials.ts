import { Credentials } from '../@types/DDO/Credentials'

/**
 * This method checks credentials
 * @param credentials ddo credentials
 * @param consumerAddress consumer address
 */
export function checkCredentials(credentials: Credentials, consumerAddress: string) {
  const consumerCredentials = {
    type: 'address',
    values: [consumerAddress]
  }

  // check allow access
  if (Array.isArray(credentials.allow) && credentials.allow.length > 0) {
    const allowCredential = credentials.allow.find(
      (credential) =>
        credential.type === consumerCredentials.type &&
        credential.values.includes(consumerCredentials.values[0].toLowerCase())
    )
    if (!allowCredential) {
      return false
    }
  }

  // check deny access
  if (Array.isArray(credentials.deny) && credentials.deny.length > 0) {
    const denyCredential = credentials.deny.find(
      (credential) =>
        credential.type === consumerCredentials.type &&
        credential.values.includes(consumerCredentials.values[0].toLowerCase())
    )
    if (denyCredential) {
      return false
    }
  }

  return true
}
