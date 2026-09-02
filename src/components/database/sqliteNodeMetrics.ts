import { SqliteClient } from './sqliteClient.js'
import { DATABASE_LOGGER } from '../../utils/logging/common.js'
import type {
  NodeMetricsEnvResource,
  NodeMetricsGpu,
  NodeMetricsHourly,
  NodeMetricsSnapshot
} from '../../@types/nodeMetrics.js'

const HOUR_MS = 60 * 60 * 1000

export function floorToHour(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS
}

// Raw sample row as stored (scalars flattened, structured fields as JSON strings).
interface SampleRow {
  collectedAt: number
  cpuUsagePercent: number
  coresAllocated: number
  hostCores: number
  throttledCount: number
  memUsedBytes: number
  memLimitBytes: number
  hostFreeBytes: number
  hostTotalBytes: number
  diskUsedBytes: number
  rxBytes: number
  txBytes: number
  jobsRunning: number
  jobsRunningFree: number
  jobsQueued: number
  jobsQueuedFree: number
  sampledContainers: number
  gpu: string
  env: string
}

// Hourly row as stored.
interface HourlyRow extends Omit<SampleRow, 'collectedAt'> {
  hourStart: number
  sampleCount: number
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/**
 * SQLite-backed history layer for per-node resource metrics.
 *
 * Two tables:
 *  - `node_metrics_samples` — raw per-minute snapshots (short-lived buffer, purged after a few
 *    hours). Input to the hourly averaging.
 *  - `node_metrics_hourly`  — one row per floored UTC hour, averaged scalars + `sampleCount`,
 *    GPU/env averaged and stored as JSON. This is what `getNodeMetricsHistory` reads.
 *
 * Uses the shared synchronous `SqliteClient`; every table is small and bounded (minute buffer
 * plus ~6 months of hourly rows), so main-thread queries are acceptable, matching the other
 * embedded SQLite databases (nonce / c2d / auth).
 */
export class NodeMetricsDatabase {
  private db: SqliteClient

  constructor(dbFilePath: string = 'databases/nodeMetrics.sqlite') {
    // SqliteClient creates the parent directory on construction.
    this.db = new SqliteClient(dbFilePath)
    this.createTables()
    DATABASE_LOGGER.info('Node metrics Database initiated with SQLite provider')
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_metrics_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collectedAt INTEGER NOT NULL,
        cpuUsagePercent REAL DEFAULT 0,
        coresAllocated REAL DEFAULT 0,
        hostCores REAL DEFAULT 0,
        throttledCount REAL DEFAULT 0,
        memUsedBytes REAL DEFAULT 0,
        memLimitBytes REAL DEFAULT 0,
        hostFreeBytes REAL DEFAULT 0,
        hostTotalBytes REAL DEFAULT 0,
        diskUsedBytes REAL DEFAULT 0,
        rxBytes REAL DEFAULT 0,
        txBytes REAL DEFAULT 0,
        jobsRunning REAL DEFAULT 0,
        jobsRunningFree REAL DEFAULT 0,
        jobsQueued REAL DEFAULT 0,
        jobsQueuedFree REAL DEFAULT 0,
        sampledContainers REAL DEFAULT 0,
        gpu TEXT DEFAULT '[]',
        env TEXT DEFAULT '[]'
      )
    `)
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_metrics_samples_collectedAt ON node_metrics_samples (collectedAt)`
    )
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_metrics_hourly (
        hourStart INTEGER PRIMARY KEY,
        sampleCount INTEGER DEFAULT 0,
        cpuUsagePercent REAL DEFAULT 0,
        coresAllocated REAL DEFAULT 0,
        hostCores REAL DEFAULT 0,
        throttledCount REAL DEFAULT 0,
        memUsedBytes REAL DEFAULT 0,
        memLimitBytes REAL DEFAULT 0,
        hostFreeBytes REAL DEFAULT 0,
        hostTotalBytes REAL DEFAULT 0,
        diskUsedBytes REAL DEFAULT 0,
        rxBytes REAL DEFAULT 0,
        txBytes REAL DEFAULT 0,
        jobsRunning REAL DEFAULT 0,
        jobsRunningFree REAL DEFAULT 0,
        jobsQueued REAL DEFAULT 0,
        jobsQueuedFree REAL DEFAULT 0,
        sampledContainers REAL DEFAULT 0,
        gpu TEXT DEFAULT '[]',
        env TEXT DEFAULT '[]'
      )
    `)
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_metrics_hourly_hourStart ON node_metrics_hourly (hourStart)`
    )
  }

  insertSample(snapshot: NodeMetricsSnapshot): void {
    this.db.run(
      `INSERT INTO node_metrics_samples (
        collectedAt, cpuUsagePercent, coresAllocated, hostCores, throttledCount,
        memUsedBytes, memLimitBytes, hostFreeBytes, hostTotalBytes, diskUsedBytes,
        rxBytes, txBytes, jobsRunning, jobsRunningFree, jobsQueued, jobsQueuedFree,
        sampledContainers, gpu, env
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.collectedAt,
        snapshot.cpu.usagePercent,
        snapshot.cpu.coresAllocated,
        snapshot.cpu.hostCores,
        snapshot.cpu.throttledCount,
        snapshot.memory.usedBytes,
        snapshot.memory.limitBytes,
        snapshot.memory.hostFreeBytes,
        snapshot.memory.hostTotalBytes,
        snapshot.disk.usedBytes,
        snapshot.network.rxBytes,
        snapshot.network.txBytes,
        snapshot.jobs.running,
        snapshot.jobs.runningFree,
        snapshot.jobs.queued,
        snapshot.jobs.queuedFree,
        snapshot.meta.sampledContainers,
        JSON.stringify(snapshot.gpu ?? []),
        JSON.stringify(snapshot.env ?? [])
      ]
    )
  }

  // Distinct floored hours that have raw samples strictly before `beforeHour` (i.e. complete
  // hours ready to roll up). `beforeHour` is a floored-hour epoch ms.
  getPendingSampleHours(beforeHour: number): number[] {
    // HOUR_MS is a compile-time module constant, not user input — the interpolation below is
    // not an injection surface. Every user-supplied value is bound via the params array.
    const rows = this.db.all<{ hourStart: number }>(
      `SELECT DISTINCT (collectedAt / ${HOUR_MS}) * ${HOUR_MS} AS hourStart
       FROM node_metrics_samples
       WHERE collectedAt < ?
       ORDER BY hourStart ASC`,
      [beforeHour]
    )
    return rows.map((r) => Math.floor(Number(r.hourStart)))
  }

  // Average every raw sample in [hourStart, hourStart+1h) into one hourly row, upsert it, then
  // delete the consumed raw samples. No samples → no row written.
  rollupHour(hourStart: number): boolean {
    const from = hourStart
    const to = hourStart + HOUR_MS
    const samples = this.db.all<SampleRow>(
      `SELECT * FROM node_metrics_samples WHERE collectedAt >= ? AND collectedAt < ?`,
      [from, to]
    )
    if (samples.length === 0) return false

    const agg = this.aggregateRows(samples, hourStart)

    this.db.run(
      `INSERT INTO node_metrics_hourly (
        hourStart, sampleCount, cpuUsagePercent, coresAllocated, hostCores, throttledCount,
        memUsedBytes, memLimitBytes, hostFreeBytes, hostTotalBytes, diskUsedBytes,
        rxBytes, txBytes, jobsRunning, jobsRunningFree, jobsQueued, jobsQueuedFree,
        sampledContainers, gpu, env
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hourStart) DO UPDATE SET
        sampleCount = excluded.sampleCount,
        cpuUsagePercent = excluded.cpuUsagePercent,
        coresAllocated = excluded.coresAllocated,
        hostCores = excluded.hostCores,
        throttledCount = excluded.throttledCount,
        memUsedBytes = excluded.memUsedBytes,
        memLimitBytes = excluded.memLimitBytes,
        hostFreeBytes = excluded.hostFreeBytes,
        hostTotalBytes = excluded.hostTotalBytes,
        diskUsedBytes = excluded.diskUsedBytes,
        rxBytes = excluded.rxBytes,
        txBytes = excluded.txBytes,
        jobsRunning = excluded.jobsRunning,
        jobsRunningFree = excluded.jobsRunningFree,
        jobsQueued = excluded.jobsQueued,
        jobsQueuedFree = excluded.jobsQueuedFree,
        sampledContainers = excluded.sampledContainers,
        gpu = excluded.gpu,
        env = excluded.env`,
      hourlyToParams(agg)
    )

    this.db.run(
      `DELETE FROM node_metrics_samples WHERE collectedAt >= ? AND collectedAt < ?`,
      [from, to]
    )
    return true
  }

  // Live, unstored average of the raw samples in an as-yet-unrolled hour (the current hour) — the
  // read-only counterpart to `rollupHour`, sharing the exact averaging via `aggregateRows`. Marks
  // the result `partial: true`. Returns null when no samples exist for that hour yet.
  getPartialHour(hourStart: number): NodeMetricsHourly | null {
    const samples = this.db.all<SampleRow>(
      `SELECT * FROM node_metrics_samples WHERE collectedAt >= ? AND collectedAt < ?`,
      [hourStart, hourStart + HOUR_MS]
    )
    if (samples.length === 0) return null
    const agg = this.aggregateRows(samples, hourStart)
    agg.partial = true
    return agg
  }

  // Averages a set of raw sample rows into one NodeMetricsHourly bucket. Pure (no DB writes) so
  // both the stored roll-up and the live partial-hour produce byte-for-byte identical shapes.
  private aggregateRows(samples: SampleRow[], hourStart: number): NodeMetricsHourly {
    const n = samples.length
    const mean = (pick: (s: SampleRow) => number): number =>
      samples.reduce((acc, s) => acc + (Number(pick(s)) || 0), 0) / n
    return {
      hourStart,
      sampleCount: n,
      cpu: {
        usagePercent: mean((s) => s.cpuUsagePercent),
        coresAllocated: mean((s) => s.coresAllocated),
        hostCores: mean((s) => s.hostCores),
        throttledCount: mean((s) => s.throttledCount)
      },
      memory: {
        usedBytes: mean((s) => s.memUsedBytes),
        limitBytes: mean((s) => s.memLimitBytes),
        hostFreeBytes: mean((s) => s.hostFreeBytes),
        hostTotalBytes: mean((s) => s.hostTotalBytes)
      },
      disk: { usedBytes: mean((s) => s.diskUsedBytes) },
      network: { rxBytes: mean((s) => s.rxBytes), txBytes: mean((s) => s.txBytes) },
      jobs: {
        running: mean((s) => s.jobsRunning),
        runningFree: mean((s) => s.jobsRunningFree),
        queued: mean((s) => s.jobsQueued),
        queuedFree: mean((s) => s.jobsQueuedFree)
      },
      gpu: averageGpu(samples.map((s) => safeParse<NodeMetricsGpu[]>(s.gpu, []))),
      env: averageEnv(samples.map((s) => safeParse<NodeMetricsEnvResource[]>(s.env, []))),
      meta: { sampledContainers: mean((s) => s.sampledContainers) }
    }
  }

  // Safety net: drop raw samples older than the buffer window (normal path consumes them in the
  // hourly rollup). `olderThan` is an epoch ms cutoff.
  purgeOldSamples(olderThan: number): number {
    const res = this.db.run(`DELETE FROM node_metrics_samples WHERE collectedAt < ?`, [
      olderThan
    ])
    return res.changes
  }

  // Retention: drop hourly rows older than the cutoff. Returns rows deleted.
  deleteHourlyOlderThan(cutoff: number): number {
    const res = this.db.run(`DELETE FROM node_metrics_hourly WHERE hourStart < ?`, [
      cutoff
    ])
    return res.changes
  }

  // Ordered hourly buckets in [from, to], capped at `limit` rows.
  getHourly(from: number, to: number, limit: number): NodeMetricsHourly[] {
    const rows = this.db.all<HourlyRow>(
      `SELECT * FROM node_metrics_hourly
       WHERE hourStart >= ? AND hourStart <= ?
       ORDER BY hourStart ASC
       LIMIT ?`,
      [from, to, limit]
    )
    return rows.map((r) => hourlyRowToApi(r))
  }
}

// Flattens a NodeMetricsHourly into the positional bind array for the node_metrics_hourly
// INSERT (column order must match the statement in rollupHour).
function hourlyToParams(h: NodeMetricsHourly): unknown[] {
  return [
    h.hourStart,
    h.sampleCount,
    h.cpu.usagePercent,
    h.cpu.coresAllocated,
    h.cpu.hostCores,
    h.cpu.throttledCount,
    h.memory.usedBytes,
    h.memory.limitBytes,
    h.memory.hostFreeBytes,
    h.memory.hostTotalBytes,
    h.disk.usedBytes,
    h.network.rxBytes,
    h.network.txBytes,
    h.jobs.running,
    h.jobs.runningFree,
    h.jobs.queued,
    h.jobs.queuedFree,
    h.meta.sampledContainers,
    JSON.stringify(h.gpu),
    JSON.stringify(h.env)
  ]
}

function hourlyRowToApi(r: HourlyRow): NodeMetricsHourly {
  return {
    hourStart: Number(r.hourStart),
    sampleCount: Number(r.sampleCount),
    cpu: {
      usagePercent: Number(r.cpuUsagePercent),
      coresAllocated: Number(r.coresAllocated),
      hostCores: Number(r.hostCores),
      throttledCount: Number(r.throttledCount)
    },
    memory: {
      usedBytes: Number(r.memUsedBytes),
      limitBytes: Number(r.memLimitBytes),
      hostFreeBytes: Number(r.hostFreeBytes),
      hostTotalBytes: Number(r.hostTotalBytes)
    },
    disk: { usedBytes: Number(r.diskUsedBytes) },
    network: { rxBytes: Number(r.rxBytes), txBytes: Number(r.txBytes) },
    jobs: {
      running: Number(r.jobsRunning),
      runningFree: Number(r.jobsRunningFree),
      queued: Number(r.jobsQueued),
      queuedFree: Number(r.jobsQueuedFree)
    },
    gpu: safeParse<NodeMetricsGpu[]>(r.gpu, []),
    env: safeParse<NodeMetricsEnvResource[]>(r.env, []),
    meta: { sampledContainers: Number(r.sampledContainers) }
  }
}

// Average each numeric GPU field per resourceId across every sample that reported that device.
// A missing metric on a given sample simply does not contribute to that field's mean.
function averageGpu(perSample: NodeMetricsGpu[][]): NodeMetricsGpu[] {
  const acc = new Map<
    string,
    {
      vendor?: string
      sums: Record<string, number>
      counts: Record<string, number>
    }
  >()
  const numericFields: (keyof NodeMetricsGpu)[] = [
    'utilizationPercent',
    'memoryUsedBytes',
    'memoryTotalBytes',
    'temperatureC',
    'powerWatts'
  ]
  for (const list of perSample) {
    for (const g of list ?? []) {
      const id = String(g.resourceId)
      if (!acc.has(id)) acc.set(id, { vendor: g.vendor, sums: {}, counts: {} })
      const entry = acc.get(id)
      if (g.vendor && !entry.vendor) entry.vendor = g.vendor
      for (const f of numericFields) {
        const v = g[f]
        if (typeof v === 'number' && Number.isFinite(v)) {
          entry.sums[f] = (entry.sums[f] ?? 0) + v
          entry.counts[f] = (entry.counts[f] ?? 0) + 1
        }
      }
    }
  }
  const out: NodeMetricsGpu[] = []
  for (const [resourceId, entry] of acc) {
    const gpu: NodeMetricsGpu = { resourceId, vendor: entry.vendor }
    for (const f of numericFields) {
      if (entry.counts[f] > 0) {
        ;(gpu[f] as number) = entry.sums[f] / entry.counts[f]
      }
    }
    out.push(gpu)
  }
  return out
}

// Average total/inUse per env+resource across every sample that reported that pair.
function averageEnv(perSample: NodeMetricsEnvResource[][]): NodeMetricsEnvResource[] {
  const acc = new Map<
    string,
    { env: string; resource: string; total: number; inUse: number; count: number }
  >()
  for (const list of perSample) {
    for (const e of list ?? []) {
      const key = `${e.env} ${e.resource}`
      if (!acc.has(key)) {
        acc.set(key, { env: e.env, resource: e.resource, total: 0, inUse: 0, count: 0 })
      }
      const entry = acc.get(key)
      entry.total += Number(e.total) || 0
      entry.inUse += Number(e.inUse) || 0
      entry.count += 1
    }
  }
  const out: NodeMetricsEnvResource[] = []
  for (const entry of acc.values()) {
    out.push({
      env: entry.env,
      resource: entry.resource,
      total: entry.count > 0 ? entry.total / entry.count : 0,
      inUse: entry.count > 0 ? entry.inUse / entry.count : 0
    })
  }
  return out
}
