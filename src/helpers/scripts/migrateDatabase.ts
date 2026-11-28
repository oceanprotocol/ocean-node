// Copies the node state in the SQLite files of databases/ (version 5.1.0 or older, or this
// release with DB_TYPE=sqlite) to the database of DB_TYPE; for DB_TYPE=sqlite it only makes a
// backup. Run by scripts/ocean-node-migrate-db.sh.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import readline from 'readline/promises'
import { fileURLToPath } from 'url'
import type { OceanNodeDBConfig } from '../../@types/OceanNode.js'
import { getConfiguration } from '../../utils/config/builder.js'
import { normalizeAddress } from '../../utils/evmAddress.js'
import { sleep } from '../../utils/util.js'
import { compareVersions } from '../../components/Indexer/version.js'
import { getPackageVersion } from '../../utils/version.js'
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

type Report = Record<string, { copied: number; failed: number }>
type Ask = (question: string) => Promise<string>
// the node is stopped during the copy, so its files are the newest state: each write creates
// the row or updates it; a nonce keeps the higher value
interface Table {
  rows: any[]
  write: (row: any) => Promise<unknown>
  // true when the row is in the target after the write; none: the write result is enough
  check?: (row: any) => Promise<boolean>
}

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
// the state files and the index file of a node with DB_TYPE=sqlite: the index is not copied,
// the node indexes the chains again
const SQLITE_FILES = [...STATE_FILES, FILES.index]
// the index version stays behind, so the node indexes the chains again
const WHERE: Record<string, string> = { config: `WHERE "key" != 'version'` }
// rows of one table read or written at the same time
const BATCH = 50
const MAX_NONCE = Number.MAX_SAFE_INTEGER
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

// how far a pass is: in a terminal one line that changes, else only the end
function progress(label: string, done: number, total: number) {
  const line = `${label} ${done}/${total}`
  if (process.stdout.isTTY) process.stdout.write(`\r${line}${done === total ? '\n' : ''}`)
  else if (done === total) console.log(line)
}

// an Elasticsearch read or write waits for the next index refresh (1 s): the rows of a batch
// wait once
async function inBatches<T>(
  label: string,
  rows: T[],
  work: (row: T, i: number) => Promise<unknown>
) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await Promise.all(rows.slice(i, i + BATCH).map((row, j) => work(row, i + j)))
    progress(label, Math.min(i + BATCH, rows.length), rows.length)
  }
}

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
  // an older release kept each casing of an address in its own row; the target keeps one.
  // REAL: node:sqlite refuses to read an integer above Number.MAX_SAFE_INTEGER
  const nonceRows = await clients.nonce.all(
    `SELECT id, CAST(nonce AS REAL) AS nonce FROM "nonce"`
  )
  const nonces = keepHighest(
    nonceRows.map((n) => ({
      id: normalizeAddress(n.id),
      nonce: Number(n.nonce)
    })),
    (n) => n.id,
    (n) => n.nonce
  )
  // SQLite kept any number; the server databases keep 64-bit integers. The highest number
  // that they and JS keep exactly still refuses every lower nonce.
  for (const n of nonces.filter((n) => n.nonce > MAX_NONCE)) {
    console.log(`The nonce of ${n.id} (${n.nonce}) is too high: it becomes ${MAX_NONCE}`)
    n.nonce = MAX_NONCE
  }
  // a SQLite node can hold one row per instance id for an hour; all go to one instance id
  const hours = keepHighest(
    await select('node_metrics_hourly'),
    (h) => h.hourStart,
    (h) => h.sampleCount
  )

  return {
    nonce: {
      rows: nonces,
      // update keeps the higher nonce; it returns null also when the target is higher
      write: (r) => target.nonce.update(r.id, r.nonce).then(() => true),
      // the target nonce must be at least the old one: a lower one opens the replay window
      check: async (r) => (await target.nonce.retrieve(r.id)).nonce >= r.nonce
    },
    config: {
      rows: await select('config'),
      write: (r) => target.config.createOrUpdateConfig(r.key, r.value),
      check: async (r) => (await target.config.retrieveValue(r.key))?.value != null
    },
    c2djobs: {
      rows: await source.c2d.getJob(),
      // newJob writes no dateFinished; updateJob writes it and the status
      write: async (j) => {
        if ((await target.c2d.getJob(j.jobId)).length === 0) await target.c2d.newJob(j)
        return (await target.c2d.updateJob(j)) || null
      },
      check: async (j) => (await target.c2d.getJob(j.jobId)).length > 0
    },
    service_jobs: {
      rows: await source.c2d.getServiceJob(),
      write: async (s) =>
        (await target.c2d.getServiceJob(s.serviceId)).length > 0
          ? (await target.c2d.updateServiceJob(s)) || null
          : target.c2d.newServiceJob(s),
      check: async (s) => (await target.c2d.getServiceJob(s.serviceId)).length > 0
    },
    docker_images: {
      rows: await select('docker_images'),
      write: (r) => target.c2d.updateImage(r.image)
    },
    authTokens: {
      rows: tokens,
      // the same id is the same token: one in the target stays as it is
      write: async (t) =>
        (await target.authToken.provider.validateTokenEntry(t.token)) ??
        target.authToken.provider.createToken(
          t.token,
          t.address,
          Number(t.createdAt),
          t.validUntil,
          t.chainId
        ),
      // a token that expires during the copy is not a failed row
      check: async (t) =>
        (t.validUntil !== null && t.validUntil <= Date.now()) ||
        (await target.authToken.provider.validateTokenEntry(t.token)) !== null
    },
    persistent_storage_buckets: {
      rows: await select('persistent_storage_buckets'),
      // the upsert keeps the label of a row that exists: the label is set after it
      write: async (b) => {
        const { bucketId, owner, accessListJson, createdAt, label } = b
        await target.buckets.upsertBucket(
          bucketId,
          owner,
          accessListJson,
          Number(createdAt),
          label
        )
        await target.buckets.updateBucketLabel(bucketId, owner, label)
      },
      check: async (b) => (await target.buckets.getBucket(b.bucketId)) !== null
    },
    node_metrics_hourly: {
      rows: hours,
      write: ({ instanceId: _, ...h }) => target.nodeMetrics.insertHourly(instanceId, h),
      check: async (h) =>
        (await target.nodeMetrics.getHourly(instanceId, h.hourStart, h.hourStart, 1))
          .length > 0
    }
  }
}

// writes each row, then checks that it is in the target
async function copyTable(name: string, table: Table) {
  const entry = { copied: 0, failed: 0 }
  await inBatches(`Copying ${name}`, table.rows, async (row) => {
    try {
      const result = await table.write(row)
      const ok = result !== null && (!table.check || (await table.check(row)))
      if (ok) entry.copied++
      else entry.failed++
    } catch (error) {
      console.error(`${name}: ${error.message}`)
      entry.failed++
    }
  })
  return entry
}

// dir: a copy of the files; upgradeLegacyTables changes them (new columns, hashed tokens)
export async function migrateState(
  dir: string,
  target: SqlStateStores,
  instanceId: string
): Promise<Report> {
  const clients = openSqliteClients(dir)
  try {
    await upgradeLegacyTables(clients)
    const source = await buildSqlStateStores({ dbType: 'sqlite' }, (g) => clients[g])
    const tables = await stateTables(clients, source, target, instanceId)
    const report: Report = {}
    for (const [name, table] of Object.entries(tables)) {
      report[name] = await copyTable(name, table)
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

// copies the SQLite files of the node, also their -wal and -shm files, to a new folder
function copySqliteFiles(folder: string): string {
  fs.mkdirSync(folder, { recursive: true })
  for (const file of sqliteFiles()) {
    fs.copyFileSync(path.join(SQLITE_DIR, file), path.join(folder, file))
  }
  return folder
}

const backup = () =>
  copySqliteFiles(
    path.join(SQLITE_DIR, `backup-${new Date().toISOString().replace(/:/g, '-')}`)
  )

// the SQLite files of the node in its folder, with their -wal and -shm files; not other
// files with these names in them, such as nonceDatabase.sqlite.old
function sqliteFiles() {
  return fs
    .readdirSync(SQLITE_DIR)
    .filter((file) =>
      SQLITE_FILES.some((name) => ['', '-wal', '-shm'].some((end) => file === name + end))
    )
}

// after a good copy the SQLite files leave the folder: the backup keeps them, and the script
// does not copy them again
function removeSqliteFiles() {
  for (const file of sqliteFiles()) {
    fs.rmSync(path.join(SQLITE_DIR, file), { force: true })
  }
}

// the checks that stop the script before it connects; null when all pass
function sourceProblem(counts: Record<string, number> | null, version: string | null) {
  if (!counts) {
    return (
      `No node state in ${SQLITE_DIR}/: check the volume of the node. If it has a ` +
      `backup-<time> folder, the state was copied already.`
    )
  }
  // files of a newer node have tables that this node does not know; the prerelease part is
  // ignored: 5.1.0-next.1 is a 5.1.0
  const node = getPackageVersion()
  if (version && compareVersions(version.split('-')[0], node.split('-')[0]) > 0) {
    return (
      `The files in ${SQLITE_DIR}/ are from version ${version}, newer than this node ` +
      `(${node}). Use the image of version ${version} or newer.`
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
  const to =
    dbConfig.dbType === 'sqlite'
      ? 'the node uses these files as they are, after a backup'
      : (URL.parse(dbConfig.url ?? '')?.host ?? '')
  console.log(`To    ${dbConfig.dbType}  ${to}`)
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
    const counts = countSourceRows(SQLITE_DIR)
    const version = sourceVersion(SQLITE_DIR)
    const problem = sourceProblem(counts, version)
    if (problem) {
      console.error(problem)
      return 1
    }
    // SQLite: the node of this release reads the same files
    const target = dbConfig.dbType === 'sqlite' ? null : await connect(dbConfig)
    if (argv.includes('--check')) return await check(counts, version, dbConfig, ask)
    if (!target) {
      console.log(`A copy of the files is in ${backup()} of the volume of the node.`)
      return 0
    }

    // the instance id of the node: OceanNode.getInstanceId() takes the same default
    const instanceId = config.instanceId || new KeyManager(config).getPeerIdString()
    const folder = backup()
    // the copy reads its own copy of the files: databases/ stays as it is until the end
    const work = copySqliteFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-')))
    const report = await migrateState(work, target, instanceId)
    fs.rmSync(work, { recursive: true, force: true })
    console.table(report)
    if (Object.values(report).some((table) => table.failed > 0)) {
      console.log(`A copy of the old files is in ${folder} of the volume of the node.`)
      return 1
    }
    // the copy is good: a file that stays does not stop the node from starting on the target
    try {
      removeSqliteFiles()
    } catch (error) {
      console.log(
        `The copy is good, but not all old files left ${SQLITE_DIR}/ (${error.message}). ` +
          `Remove them by hand: ${folder} keeps a copy.`
      )
      return 0
    }
    console.log(`The old files moved to ${folder} of the volume of the node.`)
    return 0
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
