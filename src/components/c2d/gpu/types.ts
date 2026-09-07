import type { ComputeResource } from '../../../@types/C2D/C2D.js'

export type GpuVendor = 'nvidia' | 'amd' | 'intel'

// A resolved, ready-to-sample physical GPU, derived once from a job's GPU ComputeResource.
export interface GpuDeviceHandle {
  resourceId: string // 'gpu0' — the id jobs request
  vendor: GpuVendor
  uuid?: string // nvidia: NVML UUID from init.deviceRequests.DeviceIDs
  drmCard?: string // amd/intel: 'card0' from init.advanced.Devices (future backends)
  memoryTotalBytes?: number // parsed from ComputeResource.memoryTotal, as a fallback
  shareable: boolean
}

// One live sample for one device. Nulls (not zeros) mean "backend could not provide it" so
// consumers never mistake an unreadable metric for an idle device.
export interface GpuDeviceMetrics {
  resourceId: string
  vendor: GpuVendor
  utilizationPercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
  temperatureC?: number
  powerWatts?: number
  shared?: boolean
  // Set by host-wide enumeration (sampleAll), not by job-scoped sampling: the device's stable
  // vendor identity (nvidia: NVML UUID) and its enumeration index. The GpuMetricsService uses
  // `uuid` to map an enumerated device back to a configured resource id ('gpu0'); `index` is the
  // fallback identity when no configured resource matches.
  uuid?: string
  index?: number
}

// Vendor backend contract. Only the NVIDIA (NVML) backend is implemented today; AMD/Intel
// are interface slots whose detect() returns false until their backends land.
export interface GpuVendorCollector {
  readonly vendor: GpuVendor
  detect(): Promise<boolean> // is this backend usable on this host? Run once, cached.
  resolve(res: ComputeResource): GpuDeviceHandle | null
  sample(handles: GpuDeviceHandle[]): Promise<GpuDeviceMetrics[]>
  // Enumerate and sample EVERY GPU visible to this process, with no job/handle — this is what
  // gives idle host GPUs (no running job) live utilization/memory/temperature/power. Returns []
  // when the backend is unusable on this host.
  sampleAll(): Promise<GpuDeviceMetrics[]>
  dispose(): void
}

// Parses a ComputeResource.memoryTotal string ("3072 MiB", "40960 MiB", "16 GiB", "8GB")
// into bytes. Returns undefined when absent or unparseable — callers treat it as unknown.
export function parseMemoryTotalToBytes(memoryTotal?: string): number | undefined {
  if (!memoryTotal) return undefined
  const trimmed = String(memoryTotal).trim()
  // eslint-disable-next-line security/detect-unsafe-regex
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]{1,3})?$/)
  if (!m) return undefined
  const value = parseFloat(m[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (m[2] || 'B').toLowerCase()
  const factors: Record<string, number> = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4
  }
  const factor = factors[unit]
  if (!factor) return undefined
  return Math.round(value * factor)
}
