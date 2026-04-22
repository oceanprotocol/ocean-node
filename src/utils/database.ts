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

// we can use this to check if DB connection is available
export async function isReachableConnection(url: string): Promise<boolean> {
  try {
    await fetch(url)
    return true
  } catch (error) {
    return false
  }
}
