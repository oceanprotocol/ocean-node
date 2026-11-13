/**
 * Shared node-metrics collector — the single source of truth behind both `getNodeMetrics`
 * (live) and the history sampler cron, so the live payload and the persisted rows always share
 * one shape.
 *
 * The per-node aggregate is NOT re-derived here: this lifts the exact iteration already used by
 * `src/telemetry/computeGauges.ts` (loop `engines.getAllEngines()`, read each engine's
 * `lastAggregate` + `envResourceSnapshot`, dedupe GPUs by `resourceId`) and blends in the host
 * `os` reads used by `statusHandler.ts`.
 *
 * GPUs come, like the gauges, from each engine's host-wide `hostGpuSnapshot` first (every GPU
 * visible to the node, idle included), then from the job/service-scoped `lastAggregate.gpus` for
 * any device the host enumeration could not read. Reading only `lastAggregate.gpus` left `gpu[]`
 * empty whenever no running workload had a GPU sample attached, even with live host readings.
 *
 * Never throws: a missing/undefined aggregate yields a well-formed zero/empty snapshot with
 * `hasAggregate: false`, mirroring the defensive posture of the gauge callbacks.
 */
import os from 'os'
import type { OceanNode } from '../../../OceanNode.js'
import type {
  ComputeEngineAggregate,
  ComputeGpuAggregate,
  EnvResourceSnapshot
} from '../../../telemetry/computeTypes.js'
import type {
  NodeMetricsEnvResource,
  NodeMetricsGpu,
  NodeMetricsSnapshot
} from '../../../@types/nodeMetrics.js'
import { isMetricsCollectionEnabled } from '../../c2d/containerMetrics.js'

// Read the runtime-populated fields structurally (as computeGauges.ts does) so this module does
// not depend on the concrete docker engine implementation.
type AggregatingEngine = {
  lastAggregate?: ComputeEngineAggregate
  envResourceSnapshot?: EnvResourceSnapshot
  hostGpuSnapshot?: ComputeGpuAggregate[]
}

function listEngines(node: OceanNode): AggregatingEngine[] {
  try {
    const engines = node?.getC2DEngines?.()
    return (engines?.getAllEngines?.() as AggregatingEngine[]) ?? []
  } catch {
    return []
  }
}

/**
 * True when the snapshot would carry a genuine reading rather than structural zeros: metrics
 * collection is enabled (`C2D_METRICS_INTERVAL_SECONDS > 0`) AND at least one engine has a
 * `lastAggregate` cached. Used by the sampler to warn-and-skip instead of persisting all-zero
 * rows that would skew hourly averages.
 */
export function hasFreshAggregate(node: OceanNode): boolean {
  if (!isMetricsCollectionEnabled()) return false
  return listEngines(node).some((eng) => !!eng?.lastAggregate)
}

export function collectNodeMetricsSnapshot(node: OceanNode): NodeMetricsSnapshot {
  const snapshot: NodeMetricsSnapshot = {
    collectedAt: Date.now(),
    hasAggregate: false,
    cpu: {
      usagePercent: 0,
      coresAllocated: 0,
      hostCores: 0,
      throttledCount: 0,
      loadAverage: []
    },
    memory: {
      usedBytes: 0,
      limitBytes: 0,
      hostFreeBytes: 0,
      hostTotalBytes: 0
    },
    disk: { usedBytes: 0 },
    network: { rxBytes: 0, txBytes: 0 },
    jobs: { running: 0, runningFree: 0, queued: 0, queuedFree: 0 },
    gpu: [],
    env: [],
    meta: { sampledContainers: 0, oldestSampleAgeSeconds: 0 }
  }

  // Host-level reads — always available, independent of the compute aggregate.
  try {
    snapshot.cpu.hostCores = os.cpus().length
    snapshot.cpu.loadAverage = os.loadavg()
    snapshot.memory.hostFreeBytes = os.freemem()
    snapshot.memory.hostTotalBytes = os.totalmem()
  } catch {
    // leave host defaults
  }

  // Dedupe GPUs by resourceId and env resources by env+resource across all engines, exactly as
  // computeGauges.ts does, so a GPU shared by several engines is not counted twice.
  const gpuByResourceId = new Map<string, NodeMetricsGpu>()
  const envByKey = new Map<string, NodeMetricsEnvResource>()
  // First reading seen for a resourceId wins: host-wide readings are added before job-scoped ones.
  const addGpu = (g: ComputeGpuAggregate): void => {
    if (!g) return
    const id = String(g.resourceId)
    if (gpuByResourceId.has(id)) return
    gpuByResourceId.set(id, {
      resourceId: id,
      vendor: g.vendor,
      utilizationPercent: g.utilizationPercent,
      memoryUsedBytes: g.memoryUsedBytes,
      memoryTotalBytes: g.memoryTotalBytes,
      temperatureC: g.temperatureC,
      powerWatts: g.powerWatts
    })
  }

  const engines = listEngines(node)

  // Host-wide readings are independent of the aggregate: an idle GPU still has a reading. Take
  // them from every engine before any job-scoped fallback, so precedence does not depend on
  // engine order.
  for (const eng of engines) {
    for (const g of eng?.hostGpuSnapshot ?? []) addGpu(g)
  }
  // Fallback for devices the host enumeration could not read (e.g. a job-scoped reading taken
  // before the first host sample).
  for (const eng of engines) {
    for (const g of eng?.lastAggregate?.gpus ?? []) addGpu(g)
  }

  for (const eng of engines) {
    const a = eng?.lastAggregate
    if (a) {
      snapshot.hasAggregate = true
      // Summing cpuPercent across engines assumes all engines share one physical host (each
      // engine's cpuPercent is already "percent of its own host"). That holds for today's
      // single-host C2D; a future multi-host deployment would make this a mix of denominators
      // that can exceed 100. hostCores/host memory below are intentionally NOT summed — they
      // come from a single os.* read.
      snapshot.cpu.usagePercent += a.cpuPercent ?? 0
      snapshot.cpu.coresAllocated += a.coresAllocated ?? 0
      snapshot.cpu.throttledCount += a.throttledCount ?? 0
      snapshot.memory.usedBytes += a.memUsed ?? 0
      snapshot.memory.limitBytes += a.memLimit ?? 0
      snapshot.disk.usedBytes += a.diskUsed ?? 0
      snapshot.network.rxBytes += a.rxBytes ?? 0
      snapshot.network.txBytes += a.txBytes ?? 0
      snapshot.meta.sampledContainers += a.sampledCount ?? 0
      if (
        typeof a.oldestSampleAgeSeconds === 'number' &&
        a.oldestSampleAgeSeconds > snapshot.meta.oldestSampleAgeSeconds
      ) {
        snapshot.meta.oldestSampleAgeSeconds = a.oldestSampleAgeSeconds
      }
      if (typeof a.runningJobs === 'number') snapshot.jobs.running += a.runningJobs
      if (typeof a.runningFreeJobs === 'number') {
        snapshot.jobs.runningFree += a.runningFreeJobs
      }
      if (typeof a.queuedJobs === 'number') snapshot.jobs.queued += a.queuedJobs
      if (typeof a.queuedFreeJobs === 'number') {
        snapshot.jobs.queuedFree += a.queuedFreeJobs
      }
    }

    const env = eng?.envResourceSnapshot ?? {}
    for (const [envId, resources] of Object.entries(env)) {
      for (const [rid, v] of Object.entries(resources ?? {})) {
        if (!v) continue
        const key = `${envId} ${rid}`
        if (!envByKey.has(key)) {
          envByKey.set(key, {
            env: envId,
            resource: rid,
            total: typeof v.total === 'number' ? v.total : 0,
            inUse: typeof v.inUse === 'number' ? v.inUse : 0
          })
        }
      }
    }
  }

  snapshot.gpu = Array.from(gpuByResourceId.values())
  snapshot.env = Array.from(envByKey.values())
  return snapshot
}
