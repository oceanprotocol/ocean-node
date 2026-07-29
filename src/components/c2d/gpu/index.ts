import type {
  ComputeResource,
  ComputeResourceRequest,
  GpuMetricsSnapshot
} from '../../../@types/C2D/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import { GpuDeviceHandle, GpuVendor, GpuVendorCollector } from './types.js'
import { NvmlGpuCollector } from './nvml.js'

export { parseMemoryTotalToBytes } from './types.js'

// Reads GPU_METRICS: "auto" (default) enables detect-and-pick per vendor; "off" disables
// GPU collection entirely. A per-vendor override JSON is accepted for forward-compat but,
// with only the NVIDIA backend implemented, currently just gates whether nvidia is on.
function gpuMetricsEnabled(): boolean {
  const raw = (ENVIRONMENT_VARIABLES.GPU_METRICS.value ?? 'auto').trim().toLowerCase()
  return raw !== 'off' && raw !== 'false' && raw !== '0'
}

// Infers a GPU resource's vendor when `platform` was omitted. Only NVIDIA can be inferred
// cheaply here (deviceRequests.Driver === 'nvidia'); AMD/Intel need PCI/DRM inspection that
// their (deferred) backends will own. Returns null when the vendor is unknown/unsupported.
function inferVendor(res: ComputeResource): GpuVendor | null {
  const platform = String(res.platform ?? '').toLowerCase()
  if (platform === 'nvidia' || platform === 'amd' || platform === 'intel') {
    return platform as GpuVendor
  }
  if (String(res.init?.deviceRequests?.Driver ?? '').toLowerCase() === 'nvidia') {
    return 'nvidia'
  }
  return null
}

// Resolves the GPUs a job/service actually holds and samples each one, attaching a per-device
// entry to the container snapshot. Driven entirely by job.resources → the env resource pool,
// so pure-CPU jobs never touch any GPU code. Best-effort: any failure yields no `gpu` field
// rather than disturbing the metrics/state loop. NVIDIA only today (NVML); AMD/Intel resources
// are skipped with a one-time debug note until their backends land.
export class GpuMetricsService {
  private collectors: Map<GpuVendor, GpuVendorCollector> = new Map()
  private unsupportedWarned = new Set<GpuVendor>()

  private getCollector(vendor: GpuVendor): GpuVendorCollector | null {
    if (this.collectors.has(vendor)) return this.collectors.get(vendor)!
    let collector: GpuVendorCollector | null = null
    if (vendor === 'nvidia') collector = new NvmlGpuCollector()
    // AMD/Intel backends are deferred; their resources are skipped (see below).
    if (collector) this.collectors.set(vendor, collector)
    return collector
  }

  // Returns undefined (not []) when there is nothing to report, so the caller can leave the
  // snapshot's `gpu` field absent for CPU-only jobs / disabled collection.
  async collect(
    jobResources: ComputeResourceRequest[],
    envResources: ComputeResource[]
  ): Promise<GpuMetricsSnapshot[] | undefined> {
    if (!gpuMetricsEnabled() || !jobResources?.length || !envResources?.length) {
      return undefined
    }

    // Group the held GPU resources by vendor so each backend samples its devices in one sweep.
    const byVendor = new Map<GpuVendor, GpuDeviceHandle[]>()
    try {
      for (const req of jobResources) {
        if (!req || req.amount <= 0) continue
        const res = envResources.find((r) => r.id === req.id)
        if (!res || String(res.type).toLowerCase() !== 'gpu') continue
        const vendor = inferVendor(res)
        if (!vendor) continue
        const collector = this.getCollector(vendor)
        if (!collector) {
          if (!this.unsupportedWarned.has(vendor)) {
            this.unsupportedWarned.add(vendor)
            CORE_LOGGER.debug(
              `GPU metrics: ${vendor} backend not implemented yet — skipping ${res.id}`
            )
          }
          continue
        }
        const handle = collector.resolve(res)
        if (!handle) continue
        const list = byVendor.get(vendor) ?? []
        list.push(handle)
        byVendor.set(vendor, list)
      }

      const out: GpuMetricsSnapshot[] = []
      for (const [vendor, handles] of byVendor.entries()) {
        const collector = this.getCollector(vendor)
        if (!collector) continue
        // eslint-disable-next-line no-await-in-loop
        const metrics = await collector.sample(handles)
        for (const m of metrics) {
          out.push({
            resourceId: m.resourceId,
            vendor: m.vendor,
            utilizationPercent: m.utilizationPercent,
            memoryUsedBytes: m.memoryUsedBytes,
            memoryTotalBytes: m.memoryTotalBytes,
            temperatureC: m.temperatureC,
            powerWatts: m.powerWatts,
            shared: m.shared
          })
        }
      }
      return out.length ? out : undefined
    } catch (e: any) {
      CORE_LOGGER.debug(`GPU metrics: collection failed: ${e?.message}`)
      return undefined
    }
  }

  dispose(): void {
    for (const c of this.collectors.values()) {
      try {
        c.dispose()
      } catch {
        // best-effort
      }
    }
    this.collectors.clear()
  }
}
