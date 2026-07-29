import type Dockerode from 'dockerode'
import type { ContainerMetricsSnapshot } from '../../@types/C2D/C2D.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

// PidsLimit applied to every job/service container at creation time.
const CONTAINER_PIDS_LIMIT = 512
const DEFAULT_METRICS_INTERVAL_SECONDS = 10

// Raw material for a snapshot: the Docker stats blob + inspect State, kept loosely typed
// because the shape drifts between cgroup v1/v2 and Docker API versions. buildSnapshot()
// reads it defensively.
export interface RawContainerSample {
  stats: any
  state: any // Dockerode.ContainerInspectInfo['State']
}

// Sampling cadence (seconds). Default 10; `0` disables collection entirely. Parsed from
// C2D_METRICS_INTERVAL_SECONDS; invalid/negative values fall back to the default (use 0 to
// disable). Returns seconds — callers compare against snapshot age.
export function getMetricsIntervalSeconds(): number {
  const raw = ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_METRICS_INTERVAL_SECONDS
  }
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_METRICS_INTERVAL_SECONDS
  return parsed
}

export function isMetricsCollectionEnabled(): boolean {
  return getMetricsIntervalSeconds() > 0
}

// True when the previous snapshot is older than the sampling interval (or there is none).
// Kept a pure helper so the engine wiring and unit tests share one staleness rule. `now`
// is injectable for deterministic tests.
export function isSnapshotStale(
  prev: ContainerMetricsSnapshot | undefined,
  intervalSeconds: number,
  now: number = Date.now()
): boolean {
  if (!prev || !prev.collectedAt) return true
  const age = (now - new Date(prev.collectedAt).getTime()) / 1000
  return age >= intervalSeconds
}

// Wraps a container's stats + inspect into a RawContainerSample. Never throws into the loop:
// on any failure (container gone mid-sample, daemon hiccup) it logs at debug and returns
// null so the caller keeps the previous snapshot. Uses one-shot stats (no daemon-side ~1s
// double sample) — deltas are computed by buildSnapshot from the previous snapshot instead.
export async function sampleContainerMetrics(
  docker: Dockerode,
  containerId: string,
  opts: { size?: boolean } = {}
): Promise<RawContainerSample | null> {
  try {
    const container = docker.getContainer(containerId)
    // one-shot returns instantly without precpu_stats; we self-compute CPU deltas.
    const stats: any = await container.stats({ stream: false, 'one-shot': true } as any)
    // Cast around the dockerode overloads: `size` is a valid query param but not modeled on
    // every @types/dockerode version.
    const info: any = await (container.inspect as any)(
      opts.size ? { size: true } : undefined
    )
    return { stats, state: { ...info.State, SizeRw: info.SizeRw } }
  } catch (e: any) {
    CORE_LOGGER.debug(
      `sampleContainerMetrics: could not sample container ${containerId}: ${e?.message}`
    )
    return null
  }
}

function toNum(v: any): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function sumBlkio(entries: any[], op: 'Read' | 'Write'): number {
  if (!Array.isArray(entries)) return 0
  return entries
    .filter((e) => e && String(e.op).toLowerCase() === op.toLowerCase())
    .reduce((acc, e) => acc + toNum(e.value), 0)
}

function sumNetworks(networks: any): { rxBytes: number; txBytes: number } | undefined {
  if (!networks || typeof networks !== 'object') return undefined
  let rx = 0
  let tx = 0
  for (const iface of Object.values<any>(networks)) {
    rx += toNum(iface?.rx_bytes)
    tx += toNum(iface?.tx_bytes)
  }
  return { rxBytes: rx, txBytes: tx }
}

// Pure transform: raw sample + previous snapshot → a new snapshot. Handles cgroup v1/v2
// field drift (defaults missing fields to 0), self-computes CPU % from the previous
// sample's cumulative counters (one-shot stats have no precpu_stats), tracks the memory
// peak across samples, and carries the `prev` accumulator for the next delta. Never throws;
// every read is defensive. Easily unit-tested with fixture JSON.
export function buildSnapshot(
  raw: RawContainerSample,
  prev: ContainerMetricsSnapshot | undefined,
  alloc: { cpu: number; ramBytes: number; diskBytes: number },
  diskUsedBytes: number | undefined,
  now: number = Date.now()
): ContainerMetricsSnapshot {
  const stats = raw?.stats ?? {}
  const state = raw?.state ?? {}
  const collectedAt = new Date(now).toISOString()

  // ---- CPU ----
  const cpuStats = stats.cpu_stats ?? {}
  const cpuUsage = cpuStats.cpu_usage ?? {}
  const totalUsage = toNum(cpuUsage.total_usage) // ns, monotonic
  const systemCpu = toNum(cpuStats.system_cpu_usage) // ns
  const onlineCpus =
    toNum(cpuStats.online_cpus) ||
    (Array.isArray(cpuUsage.percpu_usage) ? cpuUsage.percpu_usage.length : 0)

  // CPU % needs a previous sample. Prefer precpu_stats (non-one-shot); otherwise our stored
  // accumulator. On a true FIRST sample (neither present) we cannot compute a rate — report
  // 0 rather than a meaningless cumulative-since-boot ratio.
  const preCpu = stats.precpu_stats ?? {}
  const hasPreCpu =
    toNum(preCpu?.cpu_usage?.total_usage) > 0 && toNum(preCpu?.system_cpu_usage) > 0
  const hasPrevAccumulator =
    toNum(prev?.prev?.cpuTotal) > 0 && toNum(prev?.prev?.systemCpu) > 0
  const preTotal = hasPreCpu
    ? toNum(preCpu.cpu_usage.total_usage)
    : toNum(prev?.prev?.cpuTotal)
  const preSystem = hasPreCpu
    ? toNum(preCpu.system_cpu_usage)
    : toNum(prev?.prev?.systemCpu)

  const cpuDelta = totalUsage - preTotal
  const systemDelta = systemCpu - preSystem
  let usagePercent = 0
  if (
    (hasPreCpu || hasPrevAccumulator) &&
    cpuDelta > 0 &&
    systemDelta > 0 &&
    onlineCpus > 0
  ) {
    usagePercent = (cpuDelta / systemDelta) * onlineCpus * 100
  }
  usagePercent = Math.max(0, Number(usagePercent.toFixed(2)))

  const throttling = cpuStats.throttling_data ?? {}
  const cpu = {
    usagePercent,
    allocated: alloc.cpu,
    usagePercentOfAllocated:
      alloc.cpu > 0 ? Number((usagePercent / alloc.cpu).toFixed(2)) : 0,
    cumulativeSeconds: Number((totalUsage / 1e9).toFixed(3)),
    throttledPeriods: toNum(throttling.throttled_periods),
    throttledSeconds: Number((toNum(throttling.throttled_time) / 1e9).toFixed(3))
  }

  // ---- Memory ----
  const memStats = stats.memory_stats ?? {}
  const inactiveFile = toNum(memStats.stats?.inactive_file ?? memStats.stats?.cache)
  const usageBytes = Math.max(0, toNum(memStats.usage) - inactiveFile)
  const limitBytes = alloc.ramBytes > 0 ? alloc.ramBytes : toNum(memStats.limit)
  const peakUsageBytes = Math.max(usageBytes, toNum(prev?.memory?.peakUsageBytes))
  const memory = {
    usageBytes,
    limitBytes,
    usagePercent:
      limitBytes > 0 ? Number(((usageBytes / limitBytes) * 100).toFixed(2)) : 0,
    peakUsageBytes
  }

  // ---- Disk ----
  const resolvedDisk = diskUsedBytes !== undefined ? diskUsedBytes : toNum(state.SizeRw)
  const disk: ContainerMetricsSnapshot['disk'] = { usedBytes: Math.max(0, resolvedDisk) }
  if (alloc.diskBytes > 0) {
    disk.quotaBytes = alloc.diskBytes
    disk.usagePercent = Number(((disk.usedBytes / alloc.diskBytes) * 100).toFixed(2))
  }

  // ---- Network / Block IO / PIDs ----
  const network = sumNetworks(stats.networks)
  const blkio = stats.blkio_stats?.io_service_bytes_recursive
  const blockIO = {
    readBytes: sumBlkio(blkio, 'Read'),
    writeBytes: sumBlkio(blkio, 'Write')
  }
  const pids = {
    current: toNum(stats.pids_stats?.current),
    limit: toNum(stats.pids_stats?.limit) || CONTAINER_PIDS_LIMIT
  }

  const snapshot: ContainerMetricsSnapshot = {
    collectedAt,
    containerState: {
      status: String(state.Status ?? (state.Running ? 'running' : 'unknown')),
      startedAt: state.StartedAt,
      finishedAt:
        state.FinishedAt && !String(state.FinishedAt).startsWith('0001-01-01')
          ? state.FinishedAt
          : undefined,
      exitCode: state.ExitCode,
      oomKilled: Boolean(state.OOMKilled),
      error: state.Error || undefined,
      restartCount: toNum(state.RestartCount),
      health: state.Health?.Status
    },
    cpu,
    memory,
    disk,
    blockIO,
    pids,
    prev: { cpuTotal: totalUsage, systemCpu, sampledAt: collectedAt }
  }
  if (network) snapshot.network = network
  // GPU is attached by the caller (GpuMetricsService) after this pure transform, since it
  // needs host-side, job-resource-driven resolution outside the Docker stats blob.
  if (prev?.gpu) snapshot.gpu = prev.gpu
  return snapshot
}
