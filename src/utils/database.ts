import { OceanNodeDBConfig } from '../@types/OceanNode.js'
import { DB_TYPES } from './constants.js'
import { URLUtils } from './url.js'

export function hasValidDBConfiguration(configuration: OceanNodeDBConfig): boolean {
  if (!configuration || !configuration.dbType) {
    return false
  }
  const hasValidUrl = configuration.url && URLUtils.isValidUrl(configuration.url)
  const hasValidDbType = [DB_TYPES.ELASTIC_SEARCH, DB_TYPES.TYPESENSE].includes(
    configuration.dbType
  )

  if (!hasValidUrl || !hasValidDbType) {
    return false
  }

  // For Elasticsearch, username and password are required
  if (configuration.dbType === DB_TYPES.ELASTIC_SEARCH) {
    return !!(configuration.username && configuration.password)
  }

  return true
}

// we can use this to check if DB connection is available. An optional AbortSignal lets the caller
// cancel a probe that would otherwise hang on a URL that accepts the connection but never responds
// (the indexer aborts it when the owning start is stopped). With no signal the behaviour is
// unchanged: the probe resolves true/false purely on the fetch outcome, however long that takes.
export async function isReachableConnection(
  url: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await fetch(url, signal ? { signal } : undefined)
    return true
  } catch (error) {
    return false
  }
}
