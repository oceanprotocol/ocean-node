import { OceanNodeDBConfig } from '../@types/OceanNode.js'
import { Database } from '../components/database/index.js'
import { getConfiguration } from './config.js'
import { DB_TYPES } from './constants.js'
import { URLUtils } from './url.js'

// lazy loading
let dbConnection: Database = null

// lazy load env configuration and then db configuration
// we should be able to use this every where without dep cycle issues
export async function getDatabase(forceReload: boolean = false): Promise<Database> {
  if (!dbConnection || forceReload) {
    const { dbConfig } = await getConfiguration(true)
    if (dbConfig && dbConfig.url) {
      dbConnection = await Database.init(dbConfig)
    }
  }
  return dbConnection
}

export function hasValidDBConfiguration(configuration: OceanNodeDBConfig): boolean {
  if (!configuration || !configuration.dbType) {
    return false
  }
  return (
    configuration.url &&
    configuration.username &&
    configuration.password &&
    URLUtils.isValidUrl(configuration.url) &&
    [DB_TYPES.ELASTIC_SEARCH, DB_TYPES.TYPESENSE].includes(configuration.dbType)
  )
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
