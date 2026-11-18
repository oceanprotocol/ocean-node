import type {
  NodeMetricsEnvResource,
  NodeMetricsGpu,
  NodeMetricsHourly,
  NodeMetricsSnapshot
} from '../../@types/nodeMetrics.js'

// Rollup math for node metrics, kept in JavaScript (no Elasticsearch aggregations) so the
// stored rollup and the live partial hour give the same numbers.

export const HOUR_MS = 60 * 60 * 1000

export function floorToHour(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS
}

// Raw sample row as stored (scalars flattened, structured fields as JSON strings).
export interface SampleRow {
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
export interface HourlyRow extends Omit<SampleRow, 'collectedAt'> {
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

// a snapshot has every field of an hourly bucket
type MetricsSource = Pick<
  NodeMetricsHourly,
  'cpu' | 'memory' | 'disk' | 'network' | 'jobs' | 'meta' | 'gpu' | 'env'
>

// the fields that a sample row and an hourly row share (structured fields as JSON strings)
function metricsToRow(m: MetricsSource): Omit<SampleRow, 'collectedAt'> {
  return {
    cpuUsagePercent: m.cpu.usagePercent,
    coresAllocated: m.cpu.coresAllocated,
    hostCores: m.cpu.hostCores,
    throttledCount: m.cpu.throttledCount,
    memUsedBytes: m.memory.usedBytes,
    memLimitBytes: m.memory.limitBytes,
    hostFreeBytes: m.memory.hostFreeBytes,
    hostTotalBytes: m.memory.hostTotalBytes,
    diskUsedBytes: m.disk.usedBytes,
    rxBytes: m.network.rxBytes,
    txBytes: m.network.txBytes,
    jobsRunning: m.jobs.running,
    jobsRunningFree: m.jobs.runningFree,
    jobsQueued: m.jobs.queued,
    jobsQueuedFree: m.jobs.queuedFree,
    sampledContainers: m.meta.sampledContainers,
    gpu: JSON.stringify(m.gpu ?? []),
    env: JSON.stringify(m.env ?? [])
  }
}

export function snapshotToSampleRow(snapshot: NodeMetricsSnapshot): SampleRow {
  return { collectedAt: snapshot.collectedAt, ...metricsToRow(snapshot) }
}

export function hourlyToRow(h: NodeMetricsHourly): HourlyRow {
  return { hourStart: h.hourStart, sampleCount: h.sampleCount, ...metricsToRow(h) }
}

// Averages a set of raw sample rows into one NodeMetricsHourly bucket. Pure (no DB writes) so
// both the stored roll-up and the live partial-hour produce byte-for-byte identical shapes.
export function aggregateRows(
  samples: SampleRow[],
  hourStart: number
): NodeMetricsHourly {
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

export function hourlyRowToApi(r: HourlyRow): NodeMetricsHourly {
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
