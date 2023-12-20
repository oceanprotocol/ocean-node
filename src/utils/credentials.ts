import { Credential, Credentials } from '../@types/DDO/Credentials'

export function findCredential(
  credentials: Credential[],
  consumerCredentials: Credential
) {
  return credentials.find((credential) => {
    const credentialType = String(credential?.type).toLowerCase()
    const credentialValues = credential.values.map((v) => String(v).toLowerCase())
    return (
      credentialType === consumerCredentials.type &&
      credentialValues.includes(consumerCredentials.values[0])
    )
  })
}
/**
 * This method checks credentials
 * @param credentials credentials
 * @param consumerAddress consumer address
 */
export function checkCredentials(credentials: Credentials, consumerAddress: string) {
  const consumerCredentials = {
    type: 'address',
    values: [String(consumerAddress).toLowerCase()]
  }

  // check allow access
  if (Array.isArray(credentials.allow) && credentials.allow.length > 0) {
    const allowCredential = findCredential(credentials.allow, consumerCredentials)
    if (!allowCredential) {
      return false
    }
  }

  // check deny access
  if (Array.isArray(credentials.deny) && credentials.deny.length > 0) {
    const denyCredential = findCredential(credentials.deny, consumerCredentials)
    if (denyCredential) {
      return false
    }
  }

  return true
}
