import { DDOManager, ddoElasticMappings } from '@oceanprotocol/ddo-js'

// The DDO store keeps the DDOs of each version apart. A query selects one group with the
// `index` field; these are the names.
// "op_ddo_short" is a node-side group for deprecated DDOs (nft state !== 0).
export const DDO_SHORT_SCHEMA = 'op_ddo_short'
export const DDO_SCHEMA_NAMES: string[] = [
  ...ddoElasticMappings.map((mapping: { index: string }) => mapping.index),
  DDO_SHORT_SCHEMA
]

// the group of a DDO; undefined for a DDO with no version
export function ddoSchemaName(ddo: Record<string, any>): string | undefined {
  const ddoData = DDOManager.getDDOClass(ddo).getDDOData()
  if ('indexedMetadata' in ddoData && ddoData?.indexedMetadata?.nft?.state !== 0) {
    return DDO_SHORT_SCHEMA
  }
  return ddo.version ? `op_ddo_v${ddo.version}` : undefined
}
