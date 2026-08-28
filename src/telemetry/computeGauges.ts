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
import type { ComputeEngineAggregate, EnvResourceSnapshot } from './computeTypes.js'
import * as M from './metrics.js'

// The runtime-populated fields live on the concrete engine; read them structurally so this module
// does not depend on the docker engine implementation.
type AggregatingEngine = {
  getC2DConfig?: () => { hash?: string }
  lastAggregate?: ComputeEngineAggregate
  envResourceSnapshot?: EnvResourceSnapshot
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

          const gpus = a.gpus ?? []
          obs.observe(M.cGpuDevices, gpus.length, { engine })
          for (const g of gpus) {
            const attrs = {
              engine,
              gpu: String(g.resourceId),
              vendor: g.vendor ?? 'unknown'
            }
            obs.observe(M.cGpuUtil, g.utilizationPercent ?? 0, attrs)
            obs.observe(M.cGpuMemUsed, g.memoryUsedBytes ?? 0, attrs)
            obs.observe(M.cGpuMemTotal, g.memoryTotalBytes ?? 0, attrs)
            if (typeof g.temperatureC === 'number') {
              obs.observe(M.cGpuTemp, g.temperatureC, attrs)
            }
            if (typeof g.powerWatts === 'number') {
              obs.observe(M.cGpuPower, g.powerWatts, attrs)
            }
          }
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
