import type { ComputeResource } from '../../../@types/C2D/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import {
  GpuDeviceHandle,
  GpuDeviceMetrics,
  GpuVendorCollector,
  parseMemoryTotalToBytes
} from './types.js'

// NVIDIA GPU metrics via NVML (libnvidia-ml.so.1), loaded through the koffi prebuilt-free
// FFI. koffi is an OPTIONAL dependency and the shared library is only present on NVIDIA
// hosts, so every interaction is defensive: a load/init failure disables the backend
// (detect() → false) until the next retry, and a per-device sample failure yields nulls for
// that device. Nothing here can throw into the C2D state-machine loop.
//
// NVML is loaded lazily via a non-literal specifier so tsc does not require the module at
// build time (koffi may be absent) and a pure-CPU node never touches it.
//
// koffi type names are process-global: defining `nvmlUtilization_t` a second time throws
// "Duplicate type name". Engines (and so collectors) are rebuilt in-process — every admin
// pushConfig runs addC2DEngines(), and each docker engine owns its own GpuMetricsService — so
// the bindings are built once per koffi module and shared by every collector instance.

const NVML_SUCCESS = 0
const NVML_TEMPERATURE_GPU = 0

// A failed probe is retried after this delay, doubling per consecutive failure up to the cap,
// so a driver that comes up after the node (boot race) is picked up without a restart.
export const NVML_RETRY_MIN_MS = 30_000
export const NVML_RETRY_MAX_MS = 10 * 60_000

// Keyed by the koffi module object so a test's fake koffi never shares (or pollutes) the real one.
const sharedBindings = new WeakMap<object, NvmlBindings>()

interface NvmlBindings {
  deviceType: any
  utilizationType: any
  memoryType: any
  init: (...a: any[]) => number
  shutdown: (...a: any[]) => number
  getHandleByUUID: (...a: any[]) => number
  getUtilizationRates: (...a: any[]) => number
  getMemoryInfo: (...a: any[]) => number
  getTemperature: (...a: any[]) => number
  getPowerUsage: (...a: any[]) => number
  // Host-wide enumeration (for sampleAll): count devices, get a handle by index, read its UUID.
  getCount: (...a: any[]) => number
  getHandleByIndex: (...a: any[]) => number
  getUUID: (...a: any[]) => number
}

export class NvmlGpuCollector implements GpuVendorCollector {
  public readonly vendor = 'nvidia' as const
  private bindings: NvmlBindings | null = null
  private detected: boolean | null = null // null = not yet probed
  private initialized = false
  // Retry state after a failed probe: when the next probe may run, and how many failed in a row.
  private nextProbeAt = 0
  private failedProbes = 0
  // Concurrent callers (jobs and services are sampled in parallel) share one in-flight probe,
  // so nvmlInit runs once and one failure counts once towards the backoff.
  private probeInFlight: Promise<boolean> | null = null
  // false when no declared GPU resource is NVIDIA: probe failures are then expected (debug)
  public nvidiaConfigured = true

  // Overridable clock, so tests can step past the retry backoff without waiting.
  protected now(): number {
    return Date.now()
  }

  // Only the first failure of a streak is worth a warn; the retries that follow repeat it.
  private logProbeFailure(message: string) {
    if (this.nvidiaConfigured && this.failedProbes === 0) CORE_LOGGER.warn(message)
    else CORE_LOGGER.debug(message)
  }

  protected async loadKoffi(): Promise<any | null> {
    try {
      // Non-literal specifier: tsc treats this as `any` and does not resolve it at build
      // time, so the (optional) koffi dependency is only required at runtime on GPU hosts.
      const specifier = 'koffi'
      const mod: any = await import(specifier)
      return mod?.default ?? mod
    } catch (e: any) {
      this.logProbeFailure(
        `GPU metrics (nvidia): koffi FFI not available — NVIDIA GPU metrics disabled (${e?.message}). ` +
          `Install the 'koffi' optional dependency to enable them.`
      )
      return null
    }
  }

  // Returns the process-wide bindings for this koffi module, building them on first use. A
  // failure is not cached, so a later probe can bind once the library becomes loadable; the
  // library is loaded before any type is defined, so a missing library never leaves a
  // half-registered type name behind.
  private getBindings(koffi: any): NvmlBindings | null {
    const cached = sharedBindings.get(koffi)
    if (cached) return cached
    const built = this.buildBindings(koffi)
    if (built) sharedBindings.set(koffi, built)
    return built
  }

  private buildBindings(koffi: any): NvmlBindings | null {
    try {
      const lib = koffi.load('libnvidia-ml.so.1')
      const deviceType = koffi.pointer(koffi.opaque())
      const utilizationType = koffi.struct('nvmlUtilization_t', {
        gpu: 'uint32',
        memory: 'uint32'
      })
      const memoryType = koffi.struct('nvmlMemory_t', {
        total: 'uint64',
        free: 'uint64',
        used: 'uint64'
      })
      return {
        deviceType,
        utilizationType,
        memoryType,
        init: lib.func('nvmlInit_v2', 'int', []),
        shutdown: lib.func('nvmlShutdown', 'int', []),
        getHandleByUUID: lib.func('nvmlDeviceGetHandleByUUID', 'int', [
          'string',
          koffi.out(koffi.pointer(deviceType))
        ]),
        getUtilizationRates: lib.func('nvmlDeviceGetUtilizationRates', 'int', [
          deviceType,
          koffi.out(koffi.pointer(utilizationType))
        ]),
        getMemoryInfo: lib.func('nvmlDeviceGetMemoryInfo', 'int', [
          deviceType,
          koffi.out(koffi.pointer(memoryType))
        ]),
        getTemperature: lib.func('nvmlDeviceGetTemperature', 'int', [
          deviceType,
          'int',
          koffi.out(koffi.pointer('uint32'))
        ]),
        getPowerUsage: lib.func('nvmlDeviceGetPowerUsage', 'int', [
          deviceType,
          koffi.out(koffi.pointer('uint32'))
        ]),
        getCount: lib.func('nvmlDeviceGetCount_v2', 'int', [
          koffi.out(koffi.pointer('uint32'))
        ]),
        getHandleByIndex: lib.func('nvmlDeviceGetHandleByIndex_v2', 'int', [
          'uint32',
          koffi.out(koffi.pointer(deviceType))
        ]),
        // char* out buffer: pass a Node Buffer (mutable, passed by reference) and read the
        // null-terminated UUID back after the call.
        getUUID: lib.func('nvmlDeviceGetUUID', 'int', [
          deviceType,
          koffi.pointer('char'),
          'uint32'
        ])
      }
    } catch (e: any) {
      this.logProbeFailure(
        `GPU metrics (nvidia): could not bind libnvidia-ml.so.1 — NVIDIA GPU metrics disabled (${e?.message})`
      )
      return null
    }
  }

  // Success is cached for the collector's lifetime; failure only until the retry backoff
  // elapses (30s, doubling per consecutive failure, capped at 10 min).
  detect(): Promise<boolean> {
    if (this.detected === true) return Promise.resolve(true)
    if (this.detected === false && this.now() < this.nextProbeAt) {
      return Promise.resolve(false)
    }
    if (!this.probeInFlight) {
      this.probeInFlight = this.runProbe().finally(() => {
        this.probeInFlight = null
      })
    }
    return this.probeInFlight
  }

  private async runProbe(): Promise<boolean> {
    const ok = await this.probe()
    if (ok) {
      if (this.failedProbes > 0) {
        CORE_LOGGER.info(
          `GPU metrics (nvidia): NVML available after ${this.failedProbes} failed probe(s) — enabled`
        )
      }
      this.failedProbes = 0
      this.nextProbeAt = 0
      return (this.detected = true)
    }
    const delay = Math.min(NVML_RETRY_MIN_MS * 2 ** this.failedProbes, NVML_RETRY_MAX_MS)
    this.failedProbes++
    this.nextProbeAt = this.now() + delay
    return (this.detected = false)
  }

  private async probe(): Promise<boolean> {
    const koffi = await this.loadKoffi()
    if (!koffi) return false
    const bindings = this.getBindings(koffi)
    if (!bindings) return false
    try {
      // nvmlInit/nvmlShutdown are reference-counted by NVML, so each collector instance pairs
      // its own init with the shutdown in dispose() while sharing the bindings.
      const rc = bindings.init()
      if (rc !== NVML_SUCCESS) {
        this.logProbeFailure(
          `GPU metrics (nvidia): nvmlInit failed (code ${rc}) — disabled, will retry`
        )
        return false
      }
      this.initialized = true
      this.bindings = bindings
      return true
    } catch (e: any) {
      this.logProbeFailure(
        `GPU metrics (nvidia): nvmlInit threw — disabled, will retry (${e?.message})`
      )
      return false
    }
  }

  // Resolves a GPU ComputeResource into a handle. NVIDIA devices are pinned by NVML UUID in
  // init.deviceRequests.DeviceIDs — we take the first UUID-shaped id ("GPU-…").
  resolve(res: ComputeResource): GpuDeviceHandle | null {
    const deviceIds: string[] = res?.init?.deviceRequests?.DeviceIDs ?? []
    const uuid = deviceIds.find((id) => /^GPU-/i.test(id)) ?? deviceIds[0]
    return {
      resourceId: String(res.id),
      vendor: 'nvidia',
      uuid,
      memoryTotalBytes: parseMemoryTotalToBytes(res.memoryTotal),
      shareable: res.shareable === true
    }
  }

  // Reads the four live metrics off an already-resolved NVML device handle into `base`. Each
  // read is independent and guarded: an unreadable metric is left as its `base` default (null for
  // util/mem, absent for temp/power) rather than failing the whole sample.
  private applyDeviceReadings(device: any, base: GpuDeviceMetrics): void {
    const b = this.bindings
    if (!b) return
    const util: any = {}
    if (b.getUtilizationRates(device, util) === NVML_SUCCESS) {
      base.utilizationPercent = Number(util.gpu)
    }
    const mem: any = {}
    if (b.getMemoryInfo(device, mem) === NVML_SUCCESS) {
      base.memoryUsedBytes = Number(mem.used)
      base.memoryTotalBytes = Number(mem.total)
    }
    const tempOut: any[] = [0]
    if (b.getTemperature(device, NVML_TEMPERATURE_GPU, tempOut) === NVML_SUCCESS) {
      base.temperatureC = Number(tempOut[0])
    }
    const powerOut: any[] = [0]
    if (b.getPowerUsage(device, powerOut) === NVML_SUCCESS) {
      base.powerWatts = Number((Number(powerOut[0]) / 1000).toFixed(1)) // mW → W
    }
  }

  // Reads a device's NVML UUID ("GPU-…") into a JS string. Best-effort: returns undefined if the
  // binding is missing or the call fails, so the caller falls back to the enumeration index.
  private readUuid(device: any): string | undefined {
    const b = this.bindings
    if (!b?.getUUID) return undefined
    try {
      const buf = Buffer.alloc(96)
      if (b.getUUID(device, buf, buf.length) === NVML_SUCCESS) {
        const end = buf.indexOf(0)
        return buf.toString('latin1', 0, end < 0 ? buf.length : end)
      }
    } catch {
      // best-effort
    }
    return undefined
  }

  private sampleOne(handle: GpuDeviceHandle): GpuDeviceMetrics {
    const base: GpuDeviceMetrics = {
      resourceId: handle.resourceId,
      vendor: 'nvidia',
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: handle.memoryTotalBytes ?? null,
      shared: handle.shareable || undefined
    }
    const b = this.bindings
    if (!b || !handle.uuid) return base
    try {
      const devOut: any[] = [null]
      if (b.getHandleByUUID(handle.uuid, devOut) !== NVML_SUCCESS) return base
      this.applyDeviceReadings(devOut[0], base)
    } catch (e: any) {
      CORE_LOGGER.throttled(
        `gpu:nvml:sample:${handle.resourceId}`,
        'warn',
        `GPU metrics (nvidia): sample of ${handle.resourceId} failed: ${e?.message}`
      )
    }
    return base
  }

  async sample(handles: GpuDeviceHandle[]): Promise<GpuDeviceMetrics[]> {
    if (!(await this.detect())) return []
    return handles.map((h) => this.sampleOne(h))
  }

  // Enumerate every GPU visible to this process (nvmlDeviceGetCount + GetHandleByIndex) and
  // sample each — the host-wide path that surfaces idle GPUs no job is holding. Each entry carries
  // its NVML UUID (for mapping back to a configured resource id) and index (fallback identity).
  async sampleAll(): Promise<GpuDeviceMetrics[]> {
    if (!(await this.detect())) return []
    const b = this.bindings
    if (!b?.getCount || !b?.getHandleByIndex) return []
    const out: GpuDeviceMetrics[] = []
    try {
      const countOut: any[] = [0]
      if (b.getCount(countOut) !== NVML_SUCCESS) return []
      const count = Number(countOut[0]) || 0
      for (let i = 0; i < count; i++) {
        const devOut: any[] = [null]
        if (b.getHandleByIndex(i, devOut) !== NVML_SUCCESS) continue
        const device = devOut[0]
        const uuid = this.readUuid(device)
        const base: GpuDeviceMetrics = {
          resourceId: uuid ?? String(i),
          vendor: 'nvidia',
          utilizationPercent: null,
          memoryUsedBytes: null,
          memoryTotalBytes: null,
          uuid,
          index: i
        }
        try {
          this.applyDeviceReadings(device, base)
        } catch (e: any) {
          CORE_LOGGER.throttled(
            `gpu:nvml:device:${i}`,
            'warn',
            `GPU metrics (nvidia): sample of device ${i} failed: ${e?.message}`
          )
        }
        out.push(base)
      }
    } catch (e: any) {
      CORE_LOGGER.throttled(
        'gpu:nvml:enumeration',
        'warn',
        `GPU metrics (nvidia): host enumeration failed: ${e?.message}`
      )
    }
    return out
  }

  dispose(): void {
    try {
      if (this.initialized && this.bindings) this.bindings.shutdown()
    } catch {
      // best-effort
    }
    this.initialized = false
    // Clear the cached probe result and drop this instance's reference to the bindings so a
    // later detect() re-runs nvmlInit and sample()/sampleOne() can never use a torn-down NVML
    // handle. The shared, process-wide bindings themselves are kept for re-use.
    this.detected = null
    this.bindings = null
    this.failedProbes = 0
    this.nextProbeAt = 0
  }
}
