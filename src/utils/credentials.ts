import { P2P_CONSOLE_LOGGER } from '../components/P2P'

/**
 * This method checks credentials
 * @param ddoCredentials ddo credentials
 * @param consumerAddress consumer address
 */
export function checkCredentials(credentials, consumerAddress: string) {
  if (credentials) {
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
          credential.values.includes(consumerCredentials.values[0])
      )
      if (denyCredential) {
        return false
      }
    }
  }
  return true
}
