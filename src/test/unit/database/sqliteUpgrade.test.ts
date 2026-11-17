import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import {
  openSqliteClients,
  sqliteStateFiles,
  upgradeLegacyTables
} from '../../../components/database/sql/SqliteStores.js'
import { DatabaseFactory } from '../../../components/database/DatabaseFactory.js'
import {
  SqlStateStores,
  buildSqlStateStores
} from '../../../components/database/sql/SqlStores.js'
import { HOUR_MS } from '../../../components/database/nodeMetricsAggregate.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import type { NodeMetricsSnapshot } from '../../../@types/nodeMetrics.js'

// A node that updates from a release before the pluggable database must keep its state.
// The tables below are the ones that release made (copied from its code), with one row each.
const OWNER = '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260'
const PLAIN_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.signature'
// an older release stored the end of a token as the client sent it
const EXPIRED_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.expired.signature'
const HOUR = 500 * HOUR_MS
const METRICS =
  'cpuUsagePercent REAL DEFAULT 0, coresAllocated REAL DEFAULT 0, hostCores REAL DEFAULT 0,' +
  ' throttledCount REAL DEFAULT 0, memUsedBytes REAL DEFAULT 0, memLimitBytes REAL DEFAULT 0,' +
  ' hostFreeBytes REAL DEFAULT 0, hostTotalBytes REAL DEFAULT 0, diskUsedBytes REAL DEFAULT 0,' +
  ' rxBytes REAL DEFAULT 0, txBytes REAL DEFAULT 0, jobsRunning REAL DEFAULT 0,' +
  ' jobsRunningFree REAL DEFAULT 0, jobsQueued REAL DEFAULT 0, jobsQueuedFree REAL DEFAULT 0,' +
  " sampledContainers REAL DEFAULT 0, gpu TEXT DEFAULT '[]', env TEXT DEFAULT '[]'"

const blob = (value: unknown) => Buffer.from(JSON.stringify(value))

const LEGACY_FILES: Record<string, [string, unknown[]][]> = {
  'c2dDatabase.sqlite': [
    [
      `CREATE TABLE c2djobs (owner TEXT, did TEXT DEFAULT NULL, jobId TEXT PRIMARY KEY,
        dateCreated TEXT, dateFinished TEXT DEFAULT NULL, status INTEGER, statusText TEXT,
        results BLOB, inputDID TEXT DEFAULT NULL, algoDID TEXT DEFAULT NULL,
        agreementId TEXT DEFAULT NULL, expireTimestamp INTEGER,
        environment TEXT DEFAULT NULL, body BLOB)`,
      []
    ],
    [
      `INSERT INTO c2djobs (owner, jobId, dateCreated, status, statusText, inputDID,
        agreementId, expireTimestamp, environment, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        OWNER,
        'job-1',
        '1785760000.5',
        40,
        'Running algorithm',
        'did:op:1__,__did:op:2',
        '0xagreement',
        3600,
        'env-1',
        blob({ clusterHash: 'cluster-1', isFree: true })
      ]
    ],
    [
      `CREATE TABLE service_jobs (serviceId TEXT PRIMARY KEY, owner TEXT, clusterHash TEXT,
        status INTEGER, expiresAt INTEGER, dateCreated TEXT, body BLOB)`,
      []
    ],
    [
      'INSERT INTO service_jobs VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        'svc-1',
        OWNER,
        'cluster-1',
        ServiceStatusNumber.Expired,
        1000,
        '2026-01-01T00:00:00.000Z',
        blob({
          serviceId: 'svc-1',
          owner: OWNER,
          clusterHash: 'cluster-1',
          status: ServiceStatusNumber.Expired,
          expiresAt: 1000,
          outputArchives: [{ id: 'archive-1' }]
        })
      ]
    ]
  ],
  'persistentStorage.sqlite': [
    [
      `CREATE TABLE persistent_storage_buckets (bucketId TEXT PRIMARY KEY,
        owner TEXT NOT NULL, accessListJson TEXT NOT NULL, createdAt INTEGER NOT NULL)`,
      []
    ],
    [
      'INSERT INTO persistent_storage_buckets VALUES (?, ?, ?, ?)',
      ['b1', OWNER, '[]', 100]
    ]
  ],
  'nonceDatabase.sqlite': [
    ['CREATE TABLE nonce (id TEXT PRIMARY KEY, nonce INTEGER)', []],
    ['INSERT INTO nonce VALUES (?, ?)', [OWNER, 7]]
  ],
  'config.sqlite': [
    ['CREATE TABLE config (key TEXT NOT NULL PRIMARY KEY, value TEXT)', []],
    ['INSERT INTO config VALUES (?, ?)', ['version', '5.0.0']]
  ],
  'authTokenDatabase.sqlite': [
    [
      `CREATE TABLE authTokens (token TEXT PRIMARY KEY, address TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, validUntil DATETIME,
        isValid BOOLEAN DEFAULT TRUE)`,
      []
    ],
    [
      'INSERT INTO authTokens (token, address, createdAt, validUntil) VALUES (?, ?, ?, ?)',
      [PLAIN_TOKEN, OWNER, 1000, null]
    ],
    [
      'INSERT INTO authTokens (token, address, createdAt, validUntil) VALUES (?, ?, ?, ?)',
      [EXPIRED_TOKEN, OWNER, 1000, '2020-01-01T00:00:00.000Z']
    ]
  ],
  'nodeMetrics.sqlite': [
    [
      `CREATE TABLE node_metrics_samples (id INTEGER PRIMARY KEY AUTOINCREMENT,
        collectedAt INTEGER NOT NULL, ${METRICS})`,
      []
    ],
    [
      'INSERT INTO node_metrics_samples (collectedAt, cpuUsagePercent) VALUES (?, ?)',
      [HOUR + 1000, 40]
    ],
    [
      `CREATE TABLE node_metrics_hourly (hourStart INTEGER PRIMARY KEY,
        sampleCount INTEGER DEFAULT 0, ${METRICS})`,
      []
    ],
    [
      'INSERT INTO node_metrics_hourly (hourStart, sampleCount, cpuUsagePercent) VALUES (?, ?, ?)',
      [HOUR - HOUR_MS, 60, 15]
    ],
    // an hourly row for the hour that still has a sample: the next roll-up replaces it
    [
      'INSERT INTO node_metrics_hourly (hourStart, sampleCount, cpuUsagePercent) VALUES (?, ?, ?)',
      [HOUR, 1, 99]
    ]
  ]
}

function writeLegacyFiles(dir: string): void {
  for (const [file, statements] of Object.entries(LEGACY_FILES)) {
    const db = new DatabaseSync(path.join(dir, file))
    for (const [sql, params] of statements) {
      db.prepare(sql).run(...(params as any[]))
    }
    db.close()
  }
}

describe('SQLite stores on the databases folder of an older release', () => {
  let dir: string
  let stores: SqlStateStores
  let closeAll: () => Promise<void>

  // opens the folder the way the node does at startup
  async function openStores(): Promise<void> {
    const clients = openSqliteClients(dir)
    await upgradeLegacyTables(clients)
    stores = await buildSqlStateStores({ dbType: 'sqlite' }, (group) => clients[group])
    closeAll = async () => {
      await Promise.all(Object.values(clients).map((client) => client.close()))
    }
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-legacy-db-'))
    writeLegacyFiles(dir)
    await openStores()
  })

  after(async () => {
    await closeAll()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a compute job, with its body and its input DIDs', async () => {
    const [job] = await stores.c2d.getJob('job-1')
    expect(job.owner).to.equal(OWNER)
    expect(job.dateCreated).to.equal('1785760000.5')
    expect(job.inputDID).to.deep.equal(['did:op:1', 'did:op:2'])
    expect(job.maxJobDuration).to.equal(3600)
    expect(job.clusterHash).to.equal('cluster-1')
    expect(job.isFree).to.equal(true)
  })

  it('keeps a service job and counts its output archives', async () => {
    const [service] = await stores.c2d.getServiceJob('svc-1')
    expect(service.owner).to.equal(OWNER)
    const toClean = await stores.c2d.getExpiredServiceJobsBefore(2000)
    expect(toClean.map((job) => job.serviceId)).to.deep.equal(['svc-1'])
  })

  it('keeps a bucket, a nonce and a config value', async () => {
    expect(await stores.buckets.getBucket('b1')).to.deep.equal({
      bucketId: 'b1',
      owner: OWNER,
      accessListJson: '[]',
      createdAt: 100,
      label: null
    })
    expect((await stores.nonce.retrieve(OWNER)).nonce).to.equal(7)
    expect(await stores.config.retrieveValue('version')).to.deep.equal({ value: '5.0.0' })
  })

  it('keeps an auth token valid, and stores its hash in place of the token', async () => {
    const entry = await stores.authToken.validateToken(PLAIN_TOKEN)
    expect(entry.address).to.equal(OWNER)
    expect(entry.createdAt).to.equal(1000)
    const db = new DatabaseSync(path.join(dir, 'authTokenDatabase.sqlite'))
    const keys = db.prepare('SELECT token FROM authTokens').all()
    db.close()
    expect(keys).to.have.length(2)
    for (const key of keys) {
      expect(key.token).to.match(/^0x[0-9a-f]{64}$/)
    }
  })

  it('keeps a token expired when its end is a date text', async () => {
    expect(await stores.authToken.validateToken(EXPIRED_TOKEN)).to.equal(null)
  })

  it('shows the node metrics history before the node writes a sample', async () => {
    const hourly = await stores.nodeMetrics.getHourly('node-a', 0, HOUR, 10)
    expect(hourly.map((h) => h.hourStart)).to.deep.equal([HOUR - HOUR_MS, HOUR])
    expect(
      await stores.nodeMetrics.getPendingSampleHours('node-a', HOUR + HOUR_MS)
    ).to.deep.equal([HOUR])
  })

  it('adds a new sample to the node metrics history of the older release', async () => {
    const snapshot = {
      collectedAt: HOUR + 2000,
      hasAggregate: true,
      cpu: { usagePercent: 20, coresAllocated: 0, hostCores: 0, throttledCount: 0 },
      memory: { usedBytes: 0, limitBytes: 0, hostFreeBytes: 0, hostTotalBytes: 0 },
      disk: { usedBytes: 0 },
      network: { rxBytes: 0, txBytes: 0 },
      jobs: { running: 0, runningFree: 0, queued: 0, queuedFree: 0 },
      gpu: [],
      env: [],
      meta: { sampledContainers: 0 }
    } as unknown as NodeMetricsSnapshot
    await stores.nodeMetrics.insertSample('node-a', snapshot)
    expect(await stores.nodeMetrics.rollupHour('node-a', HOUR)).to.equal(true)
    const hourly = await stores.nodeMetrics.getHourly('node-a', 0, HOUR, 10)
    expect(
      hourly.map((h) => [h.hourStart, h.sampleCount, h.cpu.usagePercent])
    ).to.deep.equal([
      [HOUR - HOUR_MS, 60, 15],
      // the old sample (40) and the new one (20)
      [HOUR, 2, 30]
    ])
  })

  it('counts the output archives at the next start when an upgrade did not end', async () => {
    await closeAll()
    const db = new DatabaseSync(path.join(dir, 'c2dDatabase.sqlite'))
    db.exec('UPDATE service_jobs SET "outputArchiveCount" = NULL')
    db.close()
    await openStores()
    const toClean = await stores.c2d.getExpiredServiceJobsBefore(2000)
    expect(toClean.map((job) => job.serviceId)).to.deep.equal(['svc-1'])
  })

  it('refuses a database server while the folder holds node state', () => {
    expect(sqliteStateFiles(dir)).to.have.length(6)
    expect(() =>
      DatabaseFactory.refuseLeftoverSqliteState({ dbType: 'sqlite' }, dir)
    ).to.not.throw()
    expect(() =>
      DatabaseFactory.refuseLeftoverSqliteState({ dbType: 'postgresql' }, dir)
    ).to.throw(/does not move to postgresql.*DB_TYPE=sqlite/)
    // the index data can be made again: it does not stop the node
    const indexOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-index-only-'))
    fs.writeFileSync(path.join(indexOnly, 'index.sqlite'), '')
    expect(() =>
      DatabaseFactory.refuseLeftoverSqliteState({ dbType: 'elasticsearch' }, indexOnly)
    ).to.not.throw()
    fs.rmSync(indexOnly, { recursive: true, force: true })
  })

  it('opens the folder a second time with the same result', async () => {
    await closeAll()
    await openStores()
    expect((await stores.authToken.validateToken(PLAIN_TOKEN)).address).to.equal(OWNER)
    expect(await stores.c2d.getJob('job-1')).to.have.length(1)
    expect(await stores.nodeMetrics.getHourly('node-a', 0, HOUR, 10)).to.have.length(2)
  })
})
