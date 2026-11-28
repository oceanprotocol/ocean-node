import type { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { PostgresClient } from '../../components/database/sql/PostgresClient.js'
import type { SqlClient } from '../../components/database/sql/SqlClient.js'
import { SqliteClient } from '../../components/database/sql/SqliteClient.js'

// The suites of the SQL stores run on SQLite in memory. With DB_TYPE=postgresql they run
// on the PostgreSQL server of DB_URL, DB_USERNAME and DB_PASSWORD.
export const SQL_DB_TYPE = process.env.DB_TYPE === 'postgresql' ? 'postgresql' : 'sqlite'
export const SQL_DB_CONFIG: OceanNodeDBConfig = { dbType: SQL_DB_TYPE }

// read when the file loads: a test can change the DB_* variables for its own purpose
const POSTGRES_SERVER: OceanNodeDBConfig = {
  dbType: 'postgresql',
  url: process.env.DB_URL,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD
}

let schemaCount = 0

// a client on a new, empty database; close() removes the database
export function makeSqlClient(): Promise<SqlClient> {
  return SQL_DB_TYPE === 'postgresql'
    ? makePostgresClient()
    : Promise.resolve(new SqliteClient(':memory:'))
}

// Each client gets a schema of its own on the server, so a test never sees the tables of
// another test or of a node.
async function makePostgresClient(): Promise<SqlClient> {
  const config = POSTGRES_SERVER
  const schema = `ocean_test_${process.pid}_${++schemaCount}`
  const admin = new PostgresClient(config)
  await admin.exec(`CREATE SCHEMA ${schema}`)
  const url = new URL(config.url)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const client = new PostgresClient({ ...config, url: url.toString() })
  const closeClient = client.close.bind(client)
  client.close = async () => {
    await closeClient()
    await admin.exec(`DROP SCHEMA ${schema} CASCADE`)
    await admin.close()
  }
  return client
}
