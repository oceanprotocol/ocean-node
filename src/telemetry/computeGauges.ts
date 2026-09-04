/**
 * Attaches the compute observable-gauge callbacks.
 *
 * Called once after `addC2DEngines()`. A single batch callback iterates the engines each export
 * tick and observes whatever aggregate each engine has cached in `lastAggregate` /
 * `envResourceSnapshot`. Those fields are populated at runtime by the compute call-site agent (in
 * `C2DEngineDocker`); until then they are `undefined`, so everything is guarded with optional
 * chaining and the callback simply observes nothing — it must compile and run either way.
 */
import type { C2DEngines } from '../components/c2d/compute_engines.js'
import type {
  ComputeEngineAggregate,
  ComputeGpuAggregate,
  EnvResourceSnapshot
} from './computeTypes.js'
import * as M from './metrics.js'

// The runtime-populated fields live on the concrete engine; read them structurally so this module
// does not depend on the docker engine implementation.
type AggregatingEngine = {
  getC2DConfig?: () => { hash?: string }
  lastAggregate?: ComputeEngineAggregate
  envResourceSnapshot?: EnvResourceSnapshot
  hostGpuSnapshot?: ComputeGpuAggregate[]
}

export function registerComputeGauges(engines: C2DEngines): void {
  if (!engines) return

  const list = (): AggregatingEngine[] => {
    try {
      return (engines.getAllEngines?.() as AggregatingEngine[]) ?? []
    } catch {
      return []
    }
  }

  M.meter.addBatchObservableCallback(
    (obs) => {
      for (const eng of list()) {
        const a = eng?.lastAggregate
        const engine = (() => {
          try {
            return eng?.getC2DConfig?.().hash ?? 'unknown'
          } catch {
            return 'unknown'
          }
        })()

        if (a) {
          obs.observe(M.cCpuUsage, a.cpuPercent, { engine })
          obs.observe(M.cCoresAllocated, a.coresAllocated, { engine })
          obs.observe(M.cHostCores, a.hostCores, { engine })
          obs.observe(M.cThrottled, a.throttledCount, { engine })
          obs.observe(M.cMemUsed, a.memUsed, { engine })
          obs.observe(M.cMemLimit, a.memLimit, { engine })
          obs.observe(M.cDiskUsed, a.diskUsed, { engine })
          obs.observe(M.cNetRx, a.rxBytes, { engine })
          obs.observe(M.cNetTx, a.txBytes, { engine })
          obs.observe(M.cSampled, a.sampledCount, { engine })
          obs.observe(M.cSampleAge, a.oldestSampleAgeSeconds, { engine })

          if (typeof a.runningJobs === 'number') {
            obs.observe(M.cJobsRunning, a.runningJobs, { engine, free: 'false' })
          }
          if (typeof a.runningFreeJobs === 'number') {
            obs.observe(M.cJobsRunning, a.runningFreeJobs, { engine, free: 'true' })
          }
          if (typeof a.queuedJobs === 'number') {
            obs.observe(M.cJobsQueued, a.queuedJobs, { engine, free: 'false' })
          }
          if (typeof a.queuedFreeJobs === 'number') {
            obs.observe(M.cJobsQueued, a.queuedFreeJobs, { engine, free: 'true' })
          }

          // Distinct GPUs currently held by running jobs = "devices in use". The per-device
          // health series (util/mem/temp/power) are emitted below from the host-wide snapshot so
          // they exist for every GPU even when the box is idle.
          obs.observe(M.cGpuDevices, (a.gpus ?? []).length, { engine })
        }

        const env = eng?.envResourceSnapshot ?? {}
        for (const [envId, resources] of Object.entries(env)) {
          for (const [rid, v] of Object.entries(resources ?? {})) {
            if (v && typeof v.total === 'number') {
              obs.observe(M.cEnvTotal, v.total, { engine, env: envId, resource: rid })
            }
            if (v && typeof v.inUse === 'number') {
              obs.observe(M.cEnvInUse, v.inUse, { engine, env: envId, resource: rid })
            }
          }
        }

        // Per-GPU health for every visible device (idle included), sourced from the host-wide
        // NVML snapshot. `in_use` is derived from the env resource snapshot: a GPU whose resource
        // id shows inUse>0 in any environment is currently held by a job. The job-scoped a.gpus is
        // a fallback only for devices the host enumeration could not read (e.g. NVML unavailable),
        // deduped by resource id so a device is never emitted twice in one tick.
        const inUseGpuIds = new Set<string>()
        for (const resources of Object.values(env)) {
          for (const [rid, v] of Object.entries(resources ?? {})) {
            if (v && typeof v.inUse === 'number' && v.inUse > 0) inUseGpuIds.add(rid)
          }
        }
        const emittedGpuIds = new Set<string>()
        const observeGpu = (g: ComputeGpuAggregate, inUse: boolean): void => {
          const rid = String(g.resourceId)
          if (emittedGpuIds.has(rid)) return
          emittedGpuIds.add(rid)
          const attrs = {
            engine,
            gpu: rid,
            vendor: g.vendor ?? 'unknown',
            in_use: inUse ? 'true' : 'false'
          }
          if (typeof g.utilizationPercent === 'number') {
            obs.observe(M.cGpuUtil, g.utilizationPercent, attrs)
          }
          if (typeof g.memoryUsedBytes === 'number') {
            obs.observe(M.cGpuMemUsed, g.memoryUsedBytes, attrs)
          }
          if (typeof g.memoryTotalBytes === 'number') {
            obs.observe(M.cGpuMemTotal, g.memoryTotalBytes, attrs)
          }
          if (typeof g.temperatureC === 'number') {
            obs.observe(M.cGpuTemp, g.temperatureC, attrs)
          }
          if (typeof g.powerWatts === 'number') {
            obs.observe(M.cGpuPower, g.powerWatts, attrs)
          }
        }
        for (const g of eng?.hostGpuSnapshot ?? []) {
          observeGpu(g, inUseGpuIds.has(String(g.resourceId)))
        }
        for (const g of a?.gpus ?? []) {
          observeGpu(g, true)
        }
      }
    },
    [
      M.cCpuUsage,
      M.cCoresAllocated,
      M.cHostCores,
      M.cThrottled,
      M.cMemUsed,
      M.cMemLimit,
      M.cDiskUsed,
      M.cNetRx,
      M.cNetTx,
      M.cSampled,
      M.cSampleAge,
      M.cJobsRunning,
      M.cJobsQueued,
      M.cGpuDevices,
      M.cGpuUtil,
      M.cGpuMemUsed,
      M.cGpuMemTotal,
      M.cGpuTemp,
      M.cGpuPower,
      M.cEnvTotal,
      M.cEnvInUse
    ]
  )
}
