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
// (detect() → false) with a single warn log, and a per-device sample failure yields nulls
// for that device. Nothing here can throw into the C2D state-machine loop.
//
// NVML is loaded lazily via a non-literal specifier so tsc does not require the module at
// build time (koffi may be absent) and a pure-CPU node never touches it.

const NVML_SUCCESS = 0
const NVML_TEMPERATURE_GPU = 0

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
}

export class NvmlGpuCollector implements GpuVendorCollector {
  public readonly vendor = 'nvidia' as const
  private bindings: NvmlBindings | null = null
  private detected: boolean | null = null // null = not yet probed
  private initialized = false

  private async loadKoffi(): Promise<any | null> {
    try {
      // Non-literal specifier: tsc treats this as `any` and does not resolve it at build
      // time, so the (optional) koffi dependency is only required at runtime on GPU hosts.
      const specifier = 'koffi'
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const mod: any = await import(specifier)
      return mod?.default ?? mod
    } catch (e: any) {
      CORE_LOGGER.warn(
        `GPU metrics (nvidia): koffi FFI not available — NVIDIA GPU metrics disabled (${e?.message}). ` +
          `Install the 'koffi' optional dependency to enable them.`
      )
      return null
    }
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
        ])
      }
    } catch (e: any) {
      CORE_LOGGER.warn(
        `GPU metrics (nvidia): could not bind libnvidia-ml.so.1 — NVIDIA GPU metrics disabled (${e?.message})`
      )
      return null
    }
  }

  async detect(): Promise<boolean> {
    if (this.detected !== null) return this.detected
    const koffi = await this.loadKoffi()
    if (!koffi) return (this.detected = false)
    const bindings = this.buildBindings(koffi)
    if (!bindings) return (this.detected = false)
    try {
      const rc = bindings.init()
      if (rc !== NVML_SUCCESS) {
        CORE_LOGGER.warn(`GPU metrics (nvidia): nvmlInit failed (code ${rc}) — disabled`)
        return (this.detected = false)
      }
      this.initialized = true
      this.bindings = bindings
      return (this.detected = true)
    } catch (e: any) {
      CORE_LOGGER.warn(`GPU metrics (nvidia): nvmlInit threw — disabled (${e?.message})`)
      return (this.detected = false)
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
      const device = devOut[0]

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
    } catch (e: any) {
      CORE_LOGGER.debug(
        `GPU metrics (nvidia): sample of ${handle.resourceId} failed: ${e?.message}`
      )
    }
    return base
  }

  async sample(handles: GpuDeviceHandle[]): Promise<GpuDeviceMetrics[]> {
    if (!(await this.detect())) return []
    return handles.map((h) => this.sampleOne(h))
  }

  dispose(): void {
    try {
      if (this.initialized && this.bindings) this.bindings.shutdown()
    } catch {
      // best-effort
    }
    this.initialized = false
    // Clear the cached probe result and release the (now shut-down) bindings so a later
    // detect() re-initializes from scratch and sample()/sampleOne() can never use a torn-down
    // NVML handle.
    this.detected = null
    this.bindings = null
  }
}
