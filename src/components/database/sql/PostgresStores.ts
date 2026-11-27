import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import type { DatabaseStores } from '../DatabaseFactory.js'
import { PostgresClient } from './PostgresClient.js'
import { buildSqlStores } from './SqlStores.js'

// all the stores are in one database, on one connection pool
export async function createPostgresStores(
  config: OceanNodeDBConfig
): Promise<DatabaseStores> {
  const client = new PostgresClient(config)
  try {
    return await buildSqlStores(config, () => client)
  } catch (error) {
    // the node tries again with a new client
    await client.close()
    throw error
  }
}
