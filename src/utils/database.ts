import lodash from 'lodash'
import { DatabaseType, OceanNodeDBConfig } from '../@types/OceanNode.js'

// the URL schemes of the database servers; SQLite has no URL
const URL_PROTOCOLS: Partial<Record<DatabaseType, string[]>> = {
  postgresql: ['postgresql:', 'postgres:'],
  elasticsearch: ['http:', 'https:']
}

// the database server that a URL is for
export function databaseTypeOfUrl(url: unknown): DatabaseType | undefined {
  if (typeof url !== 'string' || !URL.canParse(url)) {
    return undefined
  }
  const { protocol } = new URL(url)
  return lodash.findKey(URL_PROTOCOLS, (protocols) => protocols.includes(protocol)) as
    DatabaseType | undefined
}

// What is wrong with the connection values, or undefined. SQLite needs none; a database
// server needs all three.
export function dbConfigurationProblem({
  dbType,
  url,
  username,
  password
}: OceanNodeDBConfig): string | undefined {
  if (!URL_PROTOCOLS[dbType]) {
    return undefined
  }
  if (databaseTypeOfUrl(url) !== dbType) {
    return `DB_URL must be the URL of a ${dbType} server when DB_TYPE is ${dbType}`
  }
  if (!username || !password) {
    return `DB_USERNAME and DB_PASSWORD are required when DB_TYPE is ${dbType}`
  }
  return undefined
}
