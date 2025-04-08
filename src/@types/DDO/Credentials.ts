export const KNOWN_CREDENTIALS_TYPES = ['address', 'accessList']

export interface Credential {
  type?: string
  values?: string[]
}

export interface Credentials {
  allow?: Credential[]
  deny?: Credential[]
}
