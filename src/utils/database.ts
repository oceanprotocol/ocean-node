import { Database } from '../components/database/index.js'
import { getConfiguration } from './config.js'

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
