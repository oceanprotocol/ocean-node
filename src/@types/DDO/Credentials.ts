// we will have more (user defined)
export const KNOWN_CREDENTIALS_TYPES = ['address', 'accessList']

export const CREDENTIAL_TYPES = {
  ADDRESS: KNOWN_CREDENTIALS_TYPES[0],
  ACCESS_LIST: KNOWN_CREDENTIALS_TYPES[1]
}
export interface Credential {
  type?: string
  values?: string[]
}

export interface Credentials {
  allow?: Credential[]
  deny?: Credential[]
}
