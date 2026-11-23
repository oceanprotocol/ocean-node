// Copies the node state of version 5.1.0 or older (the SQLite files of databases/) to the
// database of DB_TYPE. Run by scripts/ocean-node-migrate-db.sh.
import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import readline from 'readline/promises'
import { fileURLToPath } from 'url'
import type { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { getConfiguration } from '../../utils/config/builder.js'
import { normalizeAddress } from '../../utils/evmAddress.js'
import { sleep } from '../../utils/util.js'
import { compareVersions } from '../../components/Indexer/version.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import {
  DatabaseFactory,
  type DatabaseStores
} from '../../components/database/DatabaseFactory.js'
import { toUnixMs } from '../../components/database/AuthTokenDatabase.js'
import {
  FILES,
  SQLITE_DIR,
  type SqliteClients,
  openSqliteClients,
  upgradeLegacyTables
} from '../../components/database/sql/SqliteStores.js'
import {
  type SqlStateStores,
  type SqlStoreGroup,
  buildSqlStateStores
} from '../../components/database/sql/SqlStores.js'

type Report = Record<string, { copied: number; skipped: number; failed: number }>
type Ask = (question: string) => Promise<string>
interface Table {
  rows: any[]
  // no check: the write is an upsert, and a row is never a conflict
  exists?: (row: any) => Promise<boolean>
  write: (row: any, exists: boolean) => Promise<unknown>
  // the write merges, so the row is written also on "skip"; exists only verifies it
  merges?: boolean
}

// the copied tables and their store groups
const TABLES: Record<string, SqlStoreGroup> = {
  nonce: 'nonce',
  config: 'config',
  c2djobs: 'c2d',
  service_jobs: 'c2d',
  docker_images: 'c2d',
  authTokens: 'authToken',
  persistent_storage_buckets: 'buckets',
  node_metrics_hourly: 'nodeMetrics'
}
const STATE_FILES = [...new Set(Object.values(TABLES).map((group) => FILES[group]))]
// the index version stays behind, so the node indexes the chains again
const WHERE: Record<string, string> = { config: `WHERE "key" != 'version'` }
// rows of one table written at the same time
const WRITE_BATCH = 50
// the last release that kept all the node state in SQLite files; a newer release with
// DB_TYPE=sqlite writes its own version there, and its state is not moved
const LAST_SQLITE_RELEASE = '5.1.0'
const CONNECT_TRIES = 24
const CONNECT_WAIT_MS = 5000

function openReadOnly(dir: string, file: string): DatabaseSync | null {
  const filePath = path.join(dir, file)
  return fs.existsSync(filePath) ? new DatabaseSync(filePath, { readOnly: true }) : null
}

const hasTable = (db: DatabaseSync, name: string) =>
  db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) !== undefined

// rows per table, read-only; null when no state file exists
export function countSourceRows(dir: string): Record<string, number> | null {
  const counts: Record<string, number> = {}
  for (const [table, group] of Object.entries(TABLES)) {
    const db = openReadOnly(dir, FILES[group])
    if (!db) continue
    try {
      const sql = `SELECT COUNT(*) AS n FROM "${table}" ${WHERE[table] ?? ''}`
      counts[table] = hasTable(db, table) ? Number(db.prepare(sql).get().n) : 0
    } finally {
      db.close()
    }
  }
  return Object.keys(counts).length > 0 ? counts : null
}

// the node version in config.sqlite, read-only; null when the node did not store one
function sourceVersion(dir: string): string | null {
  const db = openReadOnly(dir, FILES.config)
  if (!db) return null
  try {
    if (!hasTable(db, 'config')) return null
    const row = db.prepare(`SELECT "value" FROM config WHERE "key" = 'version'`).get()
    return (row?.value as string) ?? null
  } finally {
    db.close()
  }
}

// the prerelease part is ignored: 5.1.0-next.1 is a 5.1.0
const isSupportedVersion = (version: string | null) =>
  !version || compareVersions(version.split('-')[0], LAST_SQLITE_RELEASE) <= 0

// one row per key, the one with the highest value
function keepHighest<T>(rows: T[], key: (row: T) => unknown, value: (row: T) => number) {
  const kept = new Map<unknown, T>()
  for (const row of rows) {
    const previous = kept.get(key(row))
    if (!previous || value(row) > value(previous)) kept.set(key(row), row)
  }
  return [...kept.values()]
}

async function stateTables(
  clients: SqliteClients,
  source: SqlStateStores,
  target: SqlStateStores,
  instanceId: string
): Promise<Record<string, Table>> {
  const select = (table: string) =>
    clients[TABLES[table]].all(`SELECT * FROM "${table}" ${WHERE[table] ?? ''}`)
  const now = Date.now()
  const tokens = (await select('authTokens'))
    .map((t) => ({
      ...t,
      validUntil: t.validUntil === null ? null : toUnixMs(t.validUntil)
    }))
    .filter((t) => t.isValid && (t.validUntil === null || t.validUntil > now))
  // an older release kept each casing of an address in its own row; the target keeps one
  const nonces = keepHighest(
    (await select('nonce')).map((n) => ({
      id: normalizeAddress(n.id),
      nonce: Number(n.nonce)
    })),
    (n) => n.id,
    (n) => n.nonce
  )
  // a SQLite node can hold one row per instance id for an hour; all go to one instance id
  const hours = keepHighest(
    await select('node_metrics_hourly'),
    (h) => h.hourStart,
    (h) => h.sampleCount
  )

  return {
    nonce: {
      rows: nonces,
      // the target nonce must be at least the old one: a lower one opens the replay window
      exists: async (r) => (await target.nonce.retrieve(r.id)).nonce >= r.nonce,
      // update keeps the higher nonce; it returns null also when the target is higher
      write: async (r) => {
        await target.nonce.update(r.id, r.nonce)
      },
      merges: true
    },
    config: {
      rows: await select('config'),
      exists: async (r) => (await target.config.retrieveValue(r.key))?.value != null,
      write: (r) => target.config.createOrUpdateConfig(r.key, r.value)
    },
    c2djobs: {
      rows: await source.c2d.getJob(),
      exists: async (j) => (await target.c2d.getJob(j.jobId)).length > 0,
      // newJob writes no dateFinished; updateJob writes it and the status
      write: async (j, exists) => {
        if (!exists) await target.c2d.newJob(j)
        return (await target.c2d.updateJob(j)) || null
      }
    },
    service_jobs: {
      rows: await source.c2d.getServiceJob(),
      exists: async (s) => (await target.c2d.getServiceJob(s.serviceId)).length > 0,
      write: async (s, exists) =>
        exists
          ? (await target.c2d.updateServiceJob(s)) || null
          : target.c2d.newServiceJob(s)
    },
    docker_images: {
      rows: await select('docker_images'),
      write: (r) => target.c2d.updateImage(r.image)
    },
    authTokens: {
      rows: tokens,
      // the same id is the same token: there is nothing to overwrite
      exists: async (t) =>
        (await target.authToken.provider.validateTokenEntry(t.token)) !== null,
      write: (t, exists) =>
        exists
          ? undefined
          : target.authToken.provider.createToken(
              t.token,
              t.address,
              Number(t.createdAt),
              t.validUntil,
              t.chainId
            )
    },
    persistent_storage_buckets: {
      rows: await select('persistent_storage_buckets'),
      exists: async (b) => (await target.buckets.getBucket(b.bucketId)) !== null,
      // a new row gets the label; an existing row keeps its label on the upsert
      write: async (b, exists) => {
        const { bucketId, owner, accessListJson, createdAt, label } = b
        await target.buckets.upsertBucket(
          bucketId,
          owner,
          accessListJson,
          Number(createdAt),
          label
        )
        if (exists) await target.buckets.updateBucketLabel(bucketId, owner, label)
      }
    },
    node_metrics_hourly: {
      rows: hours,
      exists: async (h) =>
        (await target.nodeMetrics.getHourly(instanceId, h.hourStart, h.hourStart, 1))
          .length > 0,
      write: ({ instanceId: _, ...h }) => target.nodeMetrics.insertHourly(instanceId, h)
    }
  }
}

// pass 1: the rows that the target has already; one read at a time
async function findExisting(tables: Record<string, Table>) {
  const found = new Map<string, boolean[]>()
  for (const [name, table] of Object.entries(tables)) {
    const flags: boolean[] = []
    for (const row of table.rows) {
      flags.push(!table.merges && table.exists ? await table.exists(row) : false)
    }
    found.set(name, flags)
  }
  return found
}

// true to overwrite the rows that exist; throws on cancel
async function askOverwrite(found: Map<string, boolean[]>, ask: Ask): Promise<boolean> {
  const conflicts = [...found]
    .map(([name, flags]) => [name, flags.filter(Boolean).length] as const)
    .filter(([, n]) => n > 0)
  if (conflicts.length === 0) return false
  const reply = await ask(
    `The target has some of these rows already: ${conflicts.map((c) => c.join(' ')).join(', ')}.\n` +
      'Skip them, overwrite them, or cancel? [s/o/c] '
  )
  if (reply !== 's' && reply !== 'o') throw new Error('Cancelled')
  return reply === 'o'
}

// pass 2: write each row, then check that it exists. An Elasticsearch write waits for the
// next index refresh (1 s): the rows of a batch wait once
async function copyTable(
  name: string,
  table: Table,
  flags: boolean[],
  overwrite: boolean
) {
  const entry = { copied: 0, skipped: 0, failed: 0 }
  const copy = async (row: any, i: number) => {
    if (flags[i] && !overwrite) {
      entry.skipped++
      return
    }
    try {
      const result = await table.write(row, flags[i])
      const ok = result !== null && (!table.exists || (await table.exists(row)))
      if (ok) entry.copied++
      else entry.failed++
    } catch (error) {
      console.error(`${name}: ${error.message}`)
      entry.failed++
    }
  }
  for (let i = 0; i < table.rows.length; i += WRITE_BATCH) {
    const batch = table.rows.slice(i, i + WRITE_BATCH)
    await Promise.all(batch.map((row, j) => copy(row, i + j)))
  }
  return entry
}

export async function migrateState(
  dir: string,
  target: SqlStateStores,
  instanceId: string,
  ask: Ask
): Promise<Report> {
  const clients = openSqliteClients(dir)
  try {
    await upgradeLegacyTables(clients)
    const source = await buildSqlStateStores({ dbType: 'sqlite' }, (g) => clients[g])
    const tables = await stateTables(clients, source, target, instanceId)
    const found = await findExisting(tables)
    const overwrite = await askOverwrite(found, ask)
    const report: Report = {}
    for (const [name, table] of Object.entries(tables)) {
      report[name] = await copyTable(name, table, found.get(name), overwrite)
    }
    return report
  } finally {
    await Promise.all(Object.values(clients).map((client) => client.close()))
  }
}

// the database container can still be starting
async function connect(config: OceanNodeDBConfig): Promise<DatabaseStores> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await DatabaseFactory.createStores(config)
    } catch (error) {
      if (attempt === CONNECT_TRIES) {
        // a ping that Elasticsearch refuses has no message, only a status
        const reason = error.message || `HTTP ${error.meta?.statusCode ?? error.name}`
        throw new Error(
          `Cannot connect to the database (${reason}). Check DB_URL, DB_USERNAME and DB_PASSWORD.`
        )
      }
      console.log(`Waiting for the database (${attempt}/${CONNECT_TRIES}) ...`)
      await sleep(CONNECT_WAIT_MS)
    }
  }
}

// copies the state files, also the -wal and -shm files of SQLite
function backup(): string {
  const stamp = new Date().toISOString().replace(/:/g, '-')
  const folder = path.join(SQLITE_DIR, `backup-${stamp}`)
  fs.mkdirSync(folder)
  for (const file of fs.readdirSync(SQLITE_DIR)) {
    if (STATE_FILES.some((name) => file.startsWith(name))) {
      fs.copyFileSync(path.join(SQLITE_DIR, file), path.join(folder, file))
    }
  }
  return folder
}

// the checks that stop the script before it connects; null when all pass
function sourceProblem(counts: Record<string, number> | null, version: string | null) {
  if (!counts) return `No node state in ${SQLITE_DIR}/: check the volume of the node.`
  if (!isSupportedVersion(version)) {
    return (
      `The files in ${SQLITE_DIR}/ are from version ${version}. The script copies only the ` +
      `state of version ${LAST_SQLITE_RELEASE} or older.`
    )
  }
  return null
}

// shows what the copy moves and asks to continue; 0 on "y"
async function check(
  counts: Record<string, number>,
  version: string | null,
  dbConfig: OceanNodeDBConfig,
  ask: Ask
) {
  const rows = Object.entries(counts).map(([table, n]) => `${table} ${n}`)
  console.log(
    `From  ${SQLITE_DIR}/ (version ${version ?? 'not set'})  ${rows.join(', ')}`
  )
  // the host only: the URL can hold the password
  console.log(`To    ${dbConfig.dbType}  ${URL.parse(dbConfig.url ?? '')?.host ?? ''}`)
  const reply = await ask(
    'The node stops during the copy. No compute jobs or services must run. Continue? [y/N] '
  )
  return reply === 'y' ? 0 : 1
}

async function main(argv: string[]): Promise<number> {
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  // with no more input, a question never settles and node exits with 0: that must not count
  // as a "yes"
  const ask: Ask = (question) =>
    new Promise((resolve, reject) => {
      prompt.once('close', () =>
        reject(new Error('No answer: run the script in a terminal.'))
      )
      prompt
        .question(question)
        .then((reply) => resolve(reply.trim().toLowerCase()), reject)
    })
  try {
    const config = await getConfiguration()
    const { dbConfig } = config
    if (dbConfig.dbType === 'sqlite') {
      console.log(`The node uses the files in ${SQLITE_DIR}/ directly: nothing to copy.`)
      return 2
    }
    const counts = countSourceRows(SQLITE_DIR)
    const version = sourceVersion(SQLITE_DIR)
    const problem = sourceProblem(counts, version)
    if (problem) {
      console.error(problem)
      return 1
    }
    const target = await connect(dbConfig)
    if (argv.includes('--check')) return await check(counts, version, dbConfig, ask)

    // the instance id of the node: OceanNode.getInstanceId() takes the same default
    const instanceId = config.instanceId || new KeyManager(config).getPeerIdString()
    const folder = backup()
    const report = await migrateState(SQLITE_DIR, target, instanceId, ask)
    console.table(report)
    console.log(`The old files are in ${folder} of the volume of the node.`)
    return Object.values(report).some((table) => table.failed > 0) ? 1 : 0
  } catch (error) {
    console.error(error.message)
    return 1
  } finally {
    prompt.close()
  }
}

// the guard lets a test import migrateState without running the script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
