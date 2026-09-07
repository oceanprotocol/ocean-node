import type {
  ComputeResource,
  ComputeResourceRequest,
  GpuMetricsSnapshot
} from '../../../@types/C2D/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import {
  GpuDeviceHandle,
  GpuDeviceMetrics,
  GpuVendor,
  GpuVendorCollector
} from './types.js'
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

// Maps host-enumerated device samples (from a collector's sampleAll) to snapshots, aligning each
// device's stable NVML UUID to its configured resource id ('gpu0') so host-wide GPU series share
// labels with `ocean_compute_env_resource_*` (and so `in_use` can be derived per device). A device
// with no configured UUID match falls back to a vendor+index id. Pure and NVML-free by design so
// the label logic — the one part that silently mis-labels if wrong — is unit-testable.
export function mapHostGpuDevices(
  metrics: GpuDeviceMetrics[],
  gpuResources: ComputeResource[]
): GpuMetricsSnapshot[] {
  const idByUuid = new Map<string, string>()
  for (const res of gpuResources ?? []) {
    if (String(res.type).toLowerCase() !== 'gpu') continue
    const ids: string[] = res?.init?.deviceRequests?.DeviceIDs ?? []
    const uuid = ids.find((id) => /^GPU-/i.test(id)) ?? ids[0]
    if (uuid) idByUuid.set(uuid, String(res.id))
  }
  return (metrics ?? []).map((m) => ({
    resourceId:
      (m.uuid && idByUuid.get(m.uuid)) ??
      (m.index !== undefined ? `${m.vendor}${m.index}` : m.resourceId),
    vendor: m.vendor,
    utilizationPercent: m.utilizationPercent,
    memoryUsedBytes: m.memoryUsedBytes,
    memoryTotalBytes: m.memoryTotalBytes,
    temperatureC: m.temperatureC,
    powerWatts: m.powerWatts,
    shared: m.shared
  }))
}

// Resolves the GPUs a job/service actually holds and samples each one, attaching a per-device
// entry to the container snapshot. Driven entirely by job.resources → the env resource pool,
// so pure-CPU jobs never touch any GPU code. Best-effort: any failure yields no `gpu` field
// rather than disturbing the metrics/state loop. NVIDIA only today (NVML); AMD/Intel resources
// are skipped with a one-time debug note until their backends land.
export class GpuMetricsService {
  private collectors: Map<GpuVendor, GpuVendorCollector> = new Map()
  private unsupportedWarned = new Set<GpuVendor>()
  // Resource ids whose vendor could not be determined — logged once each, not every sample.
  private unresolvedWarned = new Set<string>()

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
    let gpusHeld = 0
    try {
      for (const req of jobResources) {
        if (!req || req.amount <= 0) continue
        const res = envResources.find((r) => r.id === req.id)
        if (!res || String(res.type).toLowerCase() !== 'gpu') continue
        gpusHeld++
        const vendor = inferVendor(res)
        if (!vendor) {
          // The single most likely reason an operator sees no GPU numbers: the resource does
          // not say which vendor it is. Name the resource and the fix, once per resource.
          if (!this.unresolvedWarned.has(res.id)) {
            this.unresolvedWarned.add(res.id)
            CORE_LOGGER.debug(
              `[metrics] gpu: cannot determine the vendor of resource "${res.id}" — it has no ` +
                '"platform" ("nvidia" | "amd" | "intel") and no init.deviceRequests.Driver. Set ' +
                '"platform" on that resource in DOCKER_COMPUTE_ENVIRONMENTS to get GPU metrics.'
            )
          }
          continue
        }
        const collector = this.getCollector(vendor)
        if (!collector) {
          if (!this.unsupportedWarned.has(vendor)) {
            this.unsupportedWarned.add(vendor)
            CORE_LOGGER.debug(
              `[metrics] gpu: ${vendor} backend not implemented yet — skipping ${res.id}`
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
      if (gpusHeld > 0 && !out.length) {
        // The workload holds GPUs but nothing came back — the snapshot will simply have no
        // gpu[]. Usually a missing/unreadable vendor backend on the host, or a resource whose
        // `platform` could not be inferred; say so instead of silently omitting the field.
        CORE_LOGGER.debug(
          `[metrics] gpu: ${gpusHeld} GPU resource(s) held but no device metrics resolved — ` +
            'snapshot carries no gpu[] (check the resource platform and the host driver/tooling)'
        )
      }
      return out.length ? out : undefined
    } catch (e: any) {
      CORE_LOGGER.debug(`[metrics] gpu: collection failed: ${e?.message}`)
      return undefined
    }
  }

  // Host-wide GPU sample: every GPU visible to this process, independent of any job. This is what
  // populates the dashboard's GPU health panels while the box is idle. `gpuResources` are the
  // declared GPU ComputeResources (from the engine config) — used only to map an enumerated
  // device's NVML UUID back to its configured resource id ('gpu0') so the emitted series align
  // with `ocean_compute_env_resource_*`. A device with no matching config falls back to a
  // vendor+index id. Returns undefined when GPU collection is disabled or nothing was read.
  async sampleHost(
    gpuResources: ComputeResource[]
  ): Promise<GpuMetricsSnapshot[] | undefined> {
    if (!gpuMetricsEnabled()) return undefined
    try {
      // NVIDIA only today; AMD/Intel enumeration lands with their backends.
      const collector = this.getCollector('nvidia')
      if (!collector) return undefined
      const out = mapHostGpuDevices(await collector.sampleAll(), gpuResources)
      return out.length ? out : undefined
    } catch (e: any) {
      CORE_LOGGER.debug(`[metrics] gpu: host sample failed: ${e?.message}`)
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
