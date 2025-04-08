import { DeprecatedDDO, V4DDO, V5DDO } from '@oceanprotocol/ddo-js'

export type VersionedDDO = V5DDO | V4DDO
export type GenericDDO = VersionedDDO | DeprecatedDDO
