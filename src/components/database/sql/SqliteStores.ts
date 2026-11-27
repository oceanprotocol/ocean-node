import path from 'path'
import type { OceanNodeDBConfig } from '../../../@types/OceanNode.js'
import type { DatabaseStores } from '../DatabaseFactory.js'
import { create256Hash } from '../../../utils/crypt.js'
import { DATABASE_LOGGER } from '../../../utils/logging/common.js'
import type { SqlClient } from './SqlClient.js'
import { parseBody } from './SqlCompute.js'
import { SqlStoreGroup, buildSqlStores } from './SqlStores.js'
import { SqliteClient } from './SqliteClient.js'

export const SQLITE_DIR = 'databases'

// The file of each store group. They are the files of the releases before the pluggable
// database, so a node that updates keeps its state.
export const FILES: Record<SqlStoreGroup, string> = {
  nonce: 'nonceDatabase.sqlite',
  config: 'config.sqlite',
  c2d: 'c2dDatabase.sqlite',
  authToken: 'authTokenDatabase.sqlite',
  buckets: 'persistentStorage.sqlite',
  nodeMetrics: 'nodeMetrics.sqlite',
  // the index data and the logs
  index: 'index.sqlite'
}

export type SqliteClients = Record<SqlStoreGroup, SqlClient>

export function openSqliteClients(dir: string): SqliteClients {
  const clients = {} as SqliteClients
  for (const [group, file] of Object.entries(FILES)) {
    clients[group as SqlStoreGroup] = new SqliteClient(path.join(dir, file))
  }
  return clients
}

export async function createSqliteStores(
  config: OceanNodeDBConfig,
  dir: string = SQLITE_DIR
): Promise<DatabaseStores> {
  const clients = openSqliteClients(dir)
  try {
    await upgradeLegacyTables(clients)
    return await buildSqlStores(config, (group) => clients[group])
  } catch (error) {
    // the node tries again with new handles
    await Promise.all(Object.values(clients).map((client) => client.close()))
    throw error
  }
}

// a stored token id is the sha256 of the token
const HASHED_TOKEN = /^0x[0-9a-f]{64}$/

// Brings the tables of an older release to the form that the SQL stores use. Each step
// does nothing on a new database, and nothing when it runs again.
export async function upgradeLegacyTables(clients: SqliteClients): Promise<void> {
  const metrics = clients.nodeMetrics
  await addColumnIfMissing(metrics, 'node_metrics_samples', 'instanceId', 'TEXT')
  await addColumnIfMissing(metrics, 'node_metrics_hourly', 'instanceId', 'TEXT')
  await addColumnIfMissing(clients.buckets, 'persistent_storage_buckets', 'label', 'TEXT')
  await addColumnIfMissing(clients.authToken, 'authTokens', 'chainId', 'TEXT')
  await hashPlainTokens(clients.authToken)
  await addColumnIfMissing(clients.c2d, 'service_jobs', 'outputArchiveCount', 'BIGINT')
  await addColumnIfMissing(clients.c2d, 'service_jobs', 'logArchiveCount', 'BIGINT')
  await countArchives(clients.c2d, 'outputArchiveCount', 'outputArchives')
  await countArchives(clients.c2d, 'logArchiveCount', 'logArchives')
}

// the columns of a table; none when the table does not exist yet
async function columnsOf(db: SqlClient, table: string): Promise<string[]> {
  const columns = await db.all<{ name: string }>(`PRAGMA table_info("${table}")`)
  return columns.map((column) => column.name)
}

async function addColumnIfMissing(
  db: SqlClient,
  table: string,
  column: string,
  type: string
): Promise<void> {
  const columns = await columnsOf(db, table)
  if (columns.length > 0 && !columns.includes(column)) {
    await db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`)
  }
}

// the older releases kept the token itself as the key
function hashPlainTokens(db: SqlClient): Promise<void> {
  return db.transaction(async (tx) => {
    const tableExists = (await columnsOf(tx, 'authTokens')).length > 0
    if (!tableExists) return
    const rows = await tx.all<{ token: string }>('SELECT "token" FROM "authTokens"')
    for (const { token } of rows.filter((row) => !HASHED_TOKEN.test(row.token))) {
      await tx.run('UPDATE "authTokens" SET "token" = ? WHERE "token" = ?', [
        create256Hash(token),
        token
      ])
    }
  })
}

type ArchiveField = 'outputArchives' | 'logArchives'

// The number of archives was only in the body. Every row that has no count gets one, so a
// start that follows an upgrade that did not end does the rest.
function countArchives(
  db: SqlClient,
  column: 'outputArchiveCount' | 'logArchiveCount',
  field: ArchiveField
): Promise<void> {
  return db.transaction(async (tx) => {
    if (!(await columnsOf(tx, 'service_jobs')).includes(column)) return
    const rows = await tx.all(
      `SELECT "serviceId", "body" FROM service_jobs WHERE "${column}" IS NULL`
    )
    for (const row of rows) {
      await tx.run(`UPDATE service_jobs SET "${column}" = ? WHERE "serviceId" = ?`, [
        archiveCount(row, field),
        row.serviceId
      ])
    }
  })
}

function archiveCount(
  row: { serviceId: string; body: string | Uint8Array },
  field: ArchiveField
): number {
  try {
    return (parseBody(row.body)[field] ?? []).length
  } catch (error) {
    DATABASE_LOGGER.warn(
      `Service job ${row.serviceId} has a body that is not JSON: ${error.message}`
    )
    return 0
  }
}
