import type Dockerode from 'dockerode'
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { ServiceJob } from '../../@types/C2D/ServiceOnDemand.js'
import { SERVICE_OUTPUTS_PATH } from './serviceOutputsZip.js'

export const SERVICE_DISK_CHECK_INTERVAL_MS = 30_000
export const SERVICE_DISK_MID_INTERVAL_MS = 10_000
export const SERVICE_DISK_MIN_INTERVAL_MS = 2_000
export const SERVICE_DISK_MID_RATIO = 0.5
export const SERVICE_DISK_NEAR_RATIO = 0.8
export const SERVICE_DISK_GROWTH_FLOOR_BYTES_PER_SECOND = 1024 ** 2
export const SERVICE_DISK_PREDICTION_FRACTION = 0.5
export const SERVICE_DISK_JITTER_FRACTION = 0.1
export const SERVICE_DISK_MEASUREMENT_CONCURRENCY = 2
export const SERVICE_DISK_QUEUE_AGING_MS = 30_000

export interface ServiceDiskSample {
  containerId: string
  usedBytes: number
  at: number
  growthBytesPerSecond: number
  intervalMs: number
  // Mounts this sample could not size; usedBytes is a lower bound when non-empty.
  unmeasured?: string[]
}

// A failed or newly incomplete sample keeps the last usage but doubles the wait, so a
// service whose scan keeps timing out cannot hold a global slot every tick.
export function serviceDiskBackoffIntervalMs(intervalMs: number): number {
  return Math.min(SERVICE_DISK_CHECK_INTERVAL_MS, intervalMs * 2)
}

export function serviceDiskTimeToQuotaMs(
  usedBytes: number,
  quotaBytes: number,
  growthBytesPerSecond: number
): number {
  return (
    (Math.max(0, quotaBytes - usedBytes) /
      Math.max(growthBytesPerSecond, SERVICE_DISK_GROWTH_FLOOR_BYTES_PER_SECOND)) *
    1000
  )
}

export function serviceDiskCheckIntervalMs(
  usedBytes: number,
  quotaBytes: number,
  growthBytesPerSecond = 0,
  random = Math.random()
): number {
  const ratio = usedBytes / quotaBytes
  const band =
    ratio >= SERVICE_DISK_NEAR_RATIO
      ? SERVICE_DISK_MIN_INTERVAL_MS
      : ratio >= SERVICE_DISK_MID_RATIO
        ? SERVICE_DISK_MID_INTERVAL_MS
        : SERVICE_DISK_CHECK_INTERVAL_MS
  const predicted =
    serviceDiskTimeToQuotaMs(usedBytes, quotaBytes, growthBytesPerSecond) *
    SERVICE_DISK_PREDICTION_FRACTION
  // Subtractive jitter keeps both the maximum interval and cache-age bound strict.
  return Math.max(
    SERVICE_DISK_MIN_INTERVAL_MS,
    Math.min(band, predicted) * (1 - SERVICE_DISK_JITTER_FRACTION * random)
  )
}

// Shared across engines, not one limiter per service or Docker client. Priority is
// capped so age eventually wins; equal priorities preserve FIFO insertion order.
export function createServiceDiskMeasurementQueue(
  concurrency = SERVICE_DISK_MEASUREMENT_CONCURRENCY
): <T>(ratio: number, measure: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: {
    ratio: number
    at: number
    run: () => void
  }[] = []
  const drain = () => {
    while (active < concurrency && waiting.length) {
      const score = (entry: (typeof waiting)[number]) =>
        entry.ratio + (Date.now() - entry.at) / SERVICE_DISK_QUEUE_AGING_MS
      let best = 0
      for (let i = 1; i < waiting.length; i++) {
        if (score(waiting[i]) > score(waiting[best])) best = i
      }
      const [entry] = waiting.splice(best, 1)
      active++
      entry.run()
    }
  }
  return <T>(ratio: number, measure: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push({
        ratio: Math.max(0, Math.min(1, ratio || 0)),
        at: Date.now(),
        run: () => {
          Promise.resolve()
            .then(measure)
            .then(resolve, reject)
            .finally(() => {
              active--
              drain()
            })
        }
      })
      // Collect this tick's launches before choosing the most urgent services.
      queueMicrotask(drain)
    })
}

export const scheduleServiceDiskMeasurement = createServiceDiskMeasurementQueue()
const scheduleVolumeDf = createServiceDiskMeasurementQueue(1)
const SERVICE_DISK_MEASURE_TIMEOUT_MS = 15_000

type ServiceMount = Dockerode.ContainerInspectInfo['Mounts'][number]

export interface ServiceDiskUsage {
  usedBytes: number
  // Writable mounts that could not be sized and were counted as 0, so usedBytes is a
  // lower bound. The writable layer itself is never in here: without it there is no sample.
  unmeasured: string[]
}

// Sizes of the daemon's volumes by name, from one shared /system/df call.
export interface VolumeSizeOptions {
  maxAgeMs?: number
  // Only a scan requested at or after freshAfter (default: now) satisfies forceFresh.
  forceFresh?: boolean
  freshAfter?: number
}
export type VolumeSizes = (options?: VolumeSizeOptions) => Promise<Map<string, number>>

type VolumeCache = {
  cached?: { at: number; sizes: Map<string, number> }
  inFlight?: { at: number; sizes: Promise<Map<string, number>> }
}
const daemonVolumeCaches = new Map<string, VolumeCache>()

// SizeRw excludes every mount. Only writable disk-backed mounts belong in the extra
// charge: buckets have their own billing, RO model caches are shared, and tmpfs is RAM.
export function serviceDiskMounts(
  mounts: Dockerode.ContainerInspectInfo['Mounts'],
  outputBucketId?: string
): ServiceMount[] {
  return mounts.filter(
    (mount) =>
      mount.RW &&
      !mount.Mode?.split(',').includes('ro') &&
      (mount.Type === 'bind' || mount.Type === 'volume') &&
      !(outputBucketId && mount.Destination === SERVICE_OUTPUTS_PATH)
  )
}

// Volume sizes come from the daemon, not from du on the mount Source: when the node itself
// runs in Docker, /var/lib/docker/volumes/... is not in its mount namespace, and a node on
// the host usually cannot read it as a non-root user. Images declare such volumes (e.g.
// yanwk/comfyui-boot has VOLUME /root, where ComfyUI and every downloaded model live), so
// skipping them would miss exactly the data the quota exists for. The daemon walks every
// volume to answer, so one answer is shared by all services checked within ttlMs.
export function createVolumeSizeCache(
  docker: Dockerode,
  ttlMs: number = SERVICE_DISK_CHECK_INTERVAL_MS
): VolumeSizes {
  // Engines can have separate Dockerode objects for the same daemon. Share their
  // cache and in-flight request by endpoint; test/opaque clients stay isolated.
  const modem = docker.modem as any
  const key =
    typeof modem.socketPath === 'string' || typeof modem.host === 'string'
      ? JSON.stringify([modem.socketPath, modem.protocol, modem.host, modem.port])
      : undefined
  const state: VolumeCache = key ? (daemonVolumeCaches.get(key) ?? {}) : {}
  if (key) daemonVolumeCaches.set(key, state)
  return async ({ maxAgeMs = ttlMs, forceFresh = false, freshAfter } = {}) => {
    const after = forceFresh ? (freshAfter ?? Date.now()) : undefined
    for (;;) {
      const now = Date.now()
      if (state.inFlight) {
        // A scan requested before this caller needed fresh data may already have walked
        // past the growth it must see: let it finish, then scan again.
        if (after === undefined || state.inFlight.at >= after)
          return await state.inFlight.sizes
        await state.inFlight.sizes.catch(() => {})
        continue
      }
      // at > now only after the wall clock stepped back: never treat that entry as fresh.
      const age = state.cached ? now - state.cached.at : -1
      if (
        age >= 0 &&
        age < Math.min(ttlMs, maxAgeMs) &&
        (after === undefined || state.cached.at >= after)
      )
        return state.cached.sizes
      const inFlight: VolumeCache['inFlight'] = {
        at: now,
        sizes: scheduleVolumeDf(0, async () => {
          const at = Date.now()
          const sizes = await fetchVolumeSizes(docker)
          state.cached = { at, sizes }
          return sizes
        }).finally(() => {
          if (state.inFlight === inFlight) state.inFlight = undefined
        })
      }
      state.inFlight = inFlight
      return await inFlight.sizes
    }
  }
}

async function fetchVolumeSizes(docker: Dockerode): Promise<Map<string, number>> {
  // dockerode's df() has no query options; type=volume (API >= 1.42) keeps the daemon from
  // also sizing every container and image. Older daemons ignore it and answer in full.
  const df: any = await new Promise((resolve, reject) => {
    docker.modem.dial(
      {
        path: '/system/df?',
        method: 'GET',
        options: { type: 'volume' },
        abortSignal: AbortSignal.timeout(SERVICE_DISK_MEASURE_TIMEOUT_MS),
        statusCodes: { 200: true, 500: 'server error' }
      },
      (err: any, data: any) => (err ? reject(err) : resolve(data))
    )
  })
  const sizes = new Map<string, number>()
  for (const volume of df?.Volumes ?? []) {
    const size = volume?.UsageData?.Size
    // -1: the driver cannot report a size
    if (volume?.Name && Number.isSafeInteger(size) && size >= 0) {
      sizes.set(volume.Name, size)
    }
  }
  return sizes
}

// Host du cannot be replaced by a command in the workload: the image can omit or replace
// du. Use argv (no shell), do not follow symlinks, stay on the same filesystem, and kill
// slow scans.
async function directoryBytes(folder: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    execFile(
      'du',
      ['-skx', '--', folder],
      { timeout: SERVICE_DISK_MEASURE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return reject(error)
        const match = stdout.match(/^(\d+)\s/)
        const bytes = match ? Number(match[1]) * 1024 : NaN
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          return reject(new Error(`Unmeasurable service directory: ${folder}`))
        }
        resolve(bytes)
      }
    )
  })
}

// Writable layer and bind mounts: the per-container work that takes a measurement slot.
export interface ServiceLocalDiskUsage extends ServiceDiskUsage {
  volumes: ServiceMount[]
  startedAt: number
}

export async function measureServiceDiskUsage(
  container: Dockerode.Container,
  job: ServiceJob,
  volumeSizes?: VolumeSizes,
  volumeOptions: VolumeSizeOptions = {}
): Promise<ServiceDiskUsage> {
  return await addServiceVolumeUsage(
    await measureServiceLocalDiskUsage(container, job),
    job,
    volumeSizes,
    volumeOptions
  )
}

export async function measureServiceLocalDiskUsage(
  container: Dockerode.Container,
  job: ServiceJob
): Promise<ServiceLocalDiskUsage> {
  // Docker's SizeRw measures the writable layer directly, excluding immutable image
  // layers, bind mounts and volumes. du(/) instead walks images, buckets and RO model
  // caches and needs image-size subtraction; inspect is both more accurate and cheaper.
  // dockerode supports size but its bundled ContainerInspectOptions omits that field.
  const startedAt = Date.now()
  const options = {
    size: true,
    abortSignal: AbortSignal.timeout(SERVICE_DISK_MEASURE_TIMEOUT_MS)
  }
  const details = (await container.inspect(options)) as Dockerode.ContainerInspectInfo & {
    SizeRw?: number
  }
  if (
    !details.State?.Running ||
    !Number.isSafeInteger(details.SizeRw) ||
    details.SizeRw < 0
  ) {
    throw new Error('Container writable-layer size unavailable')
  }
  // The writable layer is always measurable through the API, so it alone is enough to
  // enforce. Mounts that cannot be sized are reported and left out instead of voiding the
  // whole sample: one unreadable path must not switch enforcement off for good.
  let bytes = details.SizeRw
  const unmeasured: string[] = []
  const mounts = serviceDiskMounts(details.Mounts ?? [], job.outputBucketId)

  const volumes = [
    ...new Map(
      mounts
        .filter((mount) => mount.Type === 'volume')
        .map((mount) => [mount.Name || mount.Destination, mount])
    ).values()
  ]

  // Retained output archives are downloadable via SERVICE_GET_RESULT but have no
  // deletion API. Count only the live container/mounts: archives must not trap a paid
  // reservation in an immediate disk-stop loop after restart. Normal storageExpiry
  // cleanup still bounds archive retention after the reservation expires.
  const folders = mounts
    .filter((mount) => mount.Type === 'bind')
    .map((mount) => mount.Source)
  const unique = [
    ...new Set(
      folders
        .filter((source) => {
          if (source && path.isAbsolute(source)) return true
          unmeasured.push(`bind ${source || '(no source)'}`)
          return false
        })
        .map((source) => path.resolve(source))
    )
  ]
  const roots = unique.filter(
    (source) =>
      !unique.some((other) => other !== source && source.startsWith(other + path.sep))
  )
  for (const folder of roots) {
    try {
      bytes += await directoryBytes(folder)
    } catch {
      unmeasured.push(folder)
    }
  }
  return { usedBytes: bytes, unmeasured, volumes, startedAt }
}

// Volume sizes come from one node-wide serialized df, so waiting for it must not hold a
// measurement slot: a slow daemon scan would otherwise stall every service's inspect/du.
export async function addServiceVolumeUsage(
  local: ServiceLocalDiskUsage,
  job: ServiceJob,
  volumeSizes?: VolumeSizes,
  volumeOptions: VolumeSizeOptions = {}
): Promise<ServiceDiskUsage> {
  const { volumes } = local
  let bytes = local.usedBytes
  const unmeasured = [...local.unmeasured]
  // Size binds first so pressure from ANY live mount also forces fresh volume data.
  if (volumes.length > 0) {
    let sizes: Map<string, number> | undefined
    try {
      sizes = await volumeSizes?.(volumeOptions)
      const quotaBytes =
        (job.resources.find((resource) => resource.id === 'disk')?.amount ?? 0) *
        1024 ** 3
      const volumeBytes = volumes.reduce(
        (total, volume) => total + (sizes?.get(volume.Name) ?? 0),
        0
      )
      // A cached answer that first reveals pressure must be refreshed in THIS check,
      // not one cadence later. Reuse a scan already started during this measurement.
      if (
        !volumeOptions.forceFresh &&
        quotaBytes > 0 &&
        (bytes + volumeBytes) / quotaBytes >= SERVICE_DISK_NEAR_RATIO
      ) {
        sizes = undefined
        sizes = await volumeSizes?.({
          ...volumeOptions,
          forceFresh: true,
          freshAfter: volumeOptions.freshAfter ?? local.startedAt
        })
      }
    } catch {}
    for (const volume of volumes) {
      const size = volume.Name ? sizes?.get(volume.Name) : undefined
      if (size === undefined)
        unmeasured.push(`volume ${volume.Name || volume.Destination}`)
      else bytes += size
    }
  }

  if (!Number.isSafeInteger(bytes)) throw new Error('Service disk size out of range')
  return { usedBytes: bytes, unmeasured }
}
