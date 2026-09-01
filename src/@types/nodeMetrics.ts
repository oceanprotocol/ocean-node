/**
 * Shapes for the per-node resource metrics API (`getNodeMetrics` /
 * `getNodeMetricsHistory`).
 *
 * A `NodeMetricsSnapshot` is the same per-node roll-up the telemetry layer already computes
 * (`ComputeEngineAggregate` on each engine's `lastAggregate`, plus host `os` reads), assembled
 * by `collectNodeMetricsSnapshot()` and shared by both the live handler and the cron sampler so
 * the live payload and the stored history have an identical shape.
 */

export interface NodeMetricsGpu {
  resourceId: string
  vendor?: string
  utilizationPercent?: number
  memoryUsedBytes?: number
  memoryTotalBytes?: number
  temperatureC?: number
  powerWatts?: number
}

export interface NodeMetricsEnvResource {
  env: string
  resource: string
  total: number
  inUse: number
}

export interface NodeMetricsSnapshot {
  // epoch ms when the snapshot was assembled
  collectedAt: number
  // Freshness signal: false means NO engine had a fresh compute aggregate, so every scalar
  // below is a structural zero rather than a genuine reading. The live handler returns the
  // snapshot regardless; the sampler uses this to warn-and-skip instead of persisting zeros.
  hasAggregate: boolean
  cpu: {
    usagePercent: number
    coresAllocated: number
    hostCores: number
    throttledCount: number
    loadAverage: number[]
  }
  memory: {
    usedBytes: number
    limitBytes: number
    hostFreeBytes: number
    hostTotalBytes: number
  }
  disk: {
    usedBytes: number
  }
  network: {
    rxBytes: number
    txBytes: number
  }
  jobs: {
    running: number
    runningFree: number
    queued: number
    queuedFree: number
  }
  gpu: NodeMetricsGpu[]
  env: NodeMetricsEnvResource[]
  meta: {
    sampledContainers: number
    oldestSampleAgeSeconds: number
  }
}

/**
 * One hourly bucket returned by `getNodeMetricsHistory`. Scalars are arithmetic means over the
 * hour's samples; `sampleCount` is how many minute-samples fed the average. GPU entries are
 * averaged per `resourceId`, env entries per `env`+`resource`.
 */
export interface NodeMetricsHourly {
  // epoch ms of the floored UTC hour this bucket covers
  hourStart: number
  sampleCount: number
  // true only for the live, not-yet-finalized current-hour bucket computed on the fly from raw
  // samples (never present on a stored/rolled-up bucket). Absent/false = a completed hour.
  partial?: boolean
  cpu: {
    usagePercent: number
    coresAllocated: number
    hostCores: number
    throttledCount: number
  }
  memory: {
    usedBytes: number
    limitBytes: number
    hostFreeBytes: number
    hostTotalBytes: number
  }
  disk: {
    usedBytes: number
  }
  network: {
    rxBytes: number
    txBytes: number
  }
  jobs: {
    running: number
    runningFree: number
    queued: number
    queuedFree: number
  }
  gpu: NodeMetricsGpu[]
  env: NodeMetricsEnvResource[]
  meta: {
    sampledContainers: number
  }
}

export interface NodeMetricsHistoryResult {
  startTime: number
  stopTime: number
  count: number
  buckets: NodeMetricsHourly[]
}
