import type { NodeMetricsHourly, NodeMetricsSnapshot } from '../../@types/nodeMetrics.js'

// per-instance node metrics history: raw minute samples rolled up into hourly buckets.
// HA instances share one peer id, so every call is keyed by the instance id.
export interface NodeMetricsProvider {
  insertSample(instanceId: string, snapshot: NodeMetricsSnapshot): Promise<void>
  // distinct floored hours with raw samples strictly before `beforeHour`, ascending
  getPendingSampleHours(instanceId: string, beforeHour: number): Promise<number[]>
  // averages the hour's samples into one hourly row, then deletes them; false when none
  rollupHour(instanceId: string, hourStart: number): Promise<boolean>
  // live, unstored average of an unrolled hour flagged partial; null when no samples
  getPartialHour(instanceId: string, hourStart: number): Promise<NodeMetricsHourly | null>
  // returns the number of samples deleted
  purgeOldSamples(instanceId: string, olderThan: number): Promise<number>
  // returns the number of hourly rows deleted
  deleteHourlyOlderThan(instanceId: string, cutoff: number): Promise<number>
  // hourStart in [from, to], ascending, at most `limit` rows
  getHourly(
    instanceId: string,
    from: number,
    to: number,
    limit: number
  ): Promise<NodeMetricsHourly[]>
}
