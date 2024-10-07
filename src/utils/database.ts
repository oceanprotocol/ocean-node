import { OceanNodeDBConfig } from '../@types/OceanNode.js'
import { Database } from '../components/database/index.js'
import { getConfiguration } from './config.js'
import { DB_TYPES } from './constants.js'
import { URLUtils } from './url.js'

// lazy loading
let dbConnection: Database = null

// lazy load env configuration and then db configuration
// we should be able to use this every where without dep cycle issues
export async function getDatabase(): Promise<Database> {
  if (!dbConnection) {
    const { dbConfig } = await getConfiguration()
    if (dbConfig && dbConfig.url) {
      dbConnection = await new Database(dbConfig)
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
    URLUtils.isValidUrl(configuration.url) &&
    [DB_TYPES.ELASTIC_SEARCH, DB_TYPES.TYPESENSE].includes(configuration.dbType)
  )
}
