import { OceanNodeDBConfig } from '../@types/OceanNode.js'
import { URLUtils } from './url.js'

export function hasValidDBConfiguration(configuration: OceanNodeDBConfig): boolean {
  if (!configuration?.url || !URLUtils.isValidUrl(configuration.url)) {
    return false
  }
  return !!(configuration.username && configuration.password)
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
