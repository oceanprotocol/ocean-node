import { OceanNodeDBConfig } from '../@types/OceanNode.js'

// What is wrong with the connection values, or undefined. SQLite needs none; a database
// server needs all three. The URL is not checked: the driver of DB_TYPE connects to it.
export function dbConfigurationProblem({
  dbType,
  url,
  username,
  password
}: OceanNodeDBConfig): string | undefined {
  if (dbType === 'sqlite') {
    return undefined
  }
  if (!url || !username || !password) {
    return `DB_URL, DB_USERNAME and DB_PASSWORD are required when DB_TYPE is ${dbType}`
  }
  return undefined
}
