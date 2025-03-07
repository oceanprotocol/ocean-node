// we will have more (user defined)
export const KNOWN_CREDENTIALS_TYPES = ['address', 'accessList'] // the ones we handle

export const CREDENTIAL_TYPES = {
  ADDRESS: KNOWN_CREDENTIALS_TYPES[0],
  ACCESS_LIST: KNOWN_CREDENTIALS_TYPES[1],
  POLICY_SERVER_SPECIFIC: 'PS-specific Type' // externally handled by Policy Server
}
export interface Credential {
  type?: string
  values?: string[]
}

export type MATCH_RULES = 'any' | 'all'

export interface Credentials {
  match_allow?: MATCH_RULES // any =>  it's enough to have one rule matched, all => all allow rules should match, default: 'all'
  match_deny: MATCH_RULES // same pattern as above, default is 'any'
  allow?: Credential[]
  deny?: Credential[]
}
