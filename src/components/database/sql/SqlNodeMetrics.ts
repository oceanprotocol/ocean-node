import type {
  NodeMetricsHourly,
  NodeMetricsSnapshot
} from '../../../@types/nodeMetrics.js'
import type { NodeMetricsProvider } from '../NodeMetricsDatabase.js'
import {
  HOUR_MS,
  HourlyRow,
  SampleRow,
  aggregateRows,
  floorToHour,
  hourlyRowToApi,
  hourlyToRow,
  snapshotToSampleRow
} from '../nodeMetricsAggregate.js'
import { SqlClient, insertRow } from './SqlClient.js'

const SAMPLES = 'node_metrics_samples'
const HOURLY = 'node_metrics_hourly'
// The rows of an instance. A database from a release that had no instances has rows with
// no instance id: SQLite has one instance for each database, so they are its rows.
const OF_INSTANCE = '("instanceId" = ? OR "instanceId" IS NULL)'
// the samples of one hour of an instance: instanceId, hourStart, hourStart + 1 h
const IN_HOUR = `${OF_INSTANCE} AND "collectedAt" >= ? AND "collectedAt" < ?`

// the number columns that the two tables share; "gpu" and "env" are JSON text
const METRIC_COLUMNS = [
  'cpuUsagePercent',
  'coresAllocated',
  'hostCores',
  'throttledCount',
  'memUsedBytes',
  'memLimitBytes',
  'hostFreeBytes',
  'hostTotalBytes',
  'diskUsedBytes',
  'rxBytes',
  'txBytes',
  'jobsRunning',
  'jobsRunningFree',
  'jobsQueued',
  'jobsQueuedFree',
  'sampledContainers'
]
const METRIC_COLUMNS_SQL = [
  ...METRIC_COLUMNS.map((column) => `"${column}" DOUBLE PRECISION DEFAULT 0`),
  `"gpu" TEXT DEFAULT '[]'`,
  `"env" TEXT DEFAULT '[]'`
].join(', ')

// Node metrics history: one sample per minute, averaged into one row per hour.
// Several instances can share the database, so each row has the id of its instance.
export class SqlNodeMetrics implements NodeMetricsProvider {
  constructor(private db: SqlClient) {}

  init(): Promise<void> {
    return this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${SAMPLES} (
        "instanceId" TEXT, "collectedAt" BIGINT NOT NULL, ${METRIC_COLUMNS_SQL}
      );
      CREATE INDEX IF NOT EXISTS idx_node_metrics_samples_instance
        ON ${SAMPLES} ("instanceId", "collectedAt");
      CREATE TABLE IF NOT EXISTS ${HOURLY} (
        "instanceId" TEXT, "hourStart" BIGINT NOT NULL, "sampleCount" BIGINT DEFAULT 0,
        ${METRIC_COLUMNS_SQL},
        PRIMARY KEY ("instanceId", "hourStart")
      );`)
  }

  async insertSample(instanceId: string, snapshot: NodeMetricsSnapshot): Promise<void> {
    await insertRow(this.db, SAMPLES, { instanceId, ...snapshotToSampleRow(snapshot) })
  }

  async getPendingSampleHours(instanceId: string, beforeHour: number): Promise<number[]> {
    const rows = await this.db.all<{ collectedAt: number }>(
      `SELECT "collectedAt" FROM ${SAMPLES} WHERE ${OF_INSTANCE} AND "collectedAt" < ?`,
      [instanceId, beforeHour]
    )
    const hours = new Set(rows.map((row) => floorToHour(row.collectedAt)))
    return [...hours].sort((a, b) => a - b)
  }

  // Averages the samples of the hour into one hourly row, then deletes them. One
  // transaction: a failure must not lose the samples or count them twice.
  rollupHour(instanceId: string, hourStart: number): Promise<boolean> {
    const hour = [instanceId, hourStart]
    return this.db.transaction(async (tx) => {
      // the samples that are deleted are the samples that are counted: a sample that
      // comes during the roll-up stays for the next one
      const samples = await tx.all<SampleRow>(
        `DELETE FROM ${SAMPLES} WHERE ${IN_HOUR} RETURNING *`,
        [...hour, hourStart + HOUR_MS]
      )
      if (samples.length === 0) return false
      await tx.run(`DELETE FROM ${HOURLY} WHERE ${OF_INSTANCE} AND "hourStart" = ?`, hour)
      await insertRow(tx, HOURLY, {
        instanceId,
        ...hourlyToRow(aggregateRows(samples, hourStart))
      })
      return true
    })
  }

  async getPartialHour(
    instanceId: string,
    hourStart: number
  ): Promise<NodeMetricsHourly | null> {
    const samples = await this.db.all<SampleRow>(
      `SELECT * FROM ${SAMPLES} WHERE ${IN_HOUR}`,
      [instanceId, hourStart, hourStart + HOUR_MS]
    )
    if (samples.length === 0) return null
    return { ...aggregateRows(samples, hourStart), partial: true }
  }

  async purgeOldSamples(instanceId: string, olderThan: number): Promise<number> {
    const { changes } = await this.db.run(
      `DELETE FROM ${SAMPLES} WHERE ${OF_INSTANCE} AND "collectedAt" < ?`,
      [instanceId, olderThan]
    )
    return changes
  }

  async deleteHourlyOlderThan(instanceId: string, cutoff: number): Promise<number> {
    const { changes } = await this.db.run(
      `DELETE FROM ${HOURLY} WHERE ${OF_INSTANCE} AND "hourStart" < ?`,
      [instanceId, cutoff]
    )
    return changes
  }

  async getHourly(
    instanceId: string,
    from: number,
    to: number,
    limit: number
  ): Promise<NodeMetricsHourly[]> {
    const rows = await this.db.all<HourlyRow>(
      `SELECT * FROM ${HOURLY}
       WHERE ${OF_INSTANCE} AND "hourStart" >= ? AND "hourStart" <= ?
       ORDER BY "hourStart" ASC LIMIT ?`,
      [instanceId, from, to, limit]
    )
    return rows.map(hourlyRowToApi)
  }
}
