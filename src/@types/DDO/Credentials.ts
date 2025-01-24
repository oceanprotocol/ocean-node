export type CredentialsType = 'address' | 'accessList'
export interface Credential {
  type?: CredentialsType
  values?: string[]
}

export interface Credentials {
  allow?: Credential[]
  deny?: Credential[]
}
