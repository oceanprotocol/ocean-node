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

export function hasCredential(credentials: Credential[]) {
  return (
    Array.isArray(credentials) &&
    credentials.length > 0 &&
    Array.isArray(credentials?.values) &&
    credentials.values.length > 0
  )
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
  // check deny access
  if (hasCredential(credentials?.deny)) {
    return !!findCredential(credentials.deny, consumerCredentials)
  }
  // check allow access
  if (hasCredential(credentials?.allow)) {
    return !findCredential(credentials.allow, consumerCredentials)
  }
  return true
}
