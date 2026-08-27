/**
 * Shared telemetry types for the compute aggregate.
 *
 * Consumed by both `computeGauges.ts` (which observes them) and the compute call-site agent (which
 * populates `C2DEngineDocker.lastAggregate` / `.envResourceSnapshot` at runtime). Kept here, free
 * of any SDK or engine import, so both sides can depend on the shapes without a cycle.
 */

export interface ComputeGpuAggregate {
  resourceId: string | number
  vendor?: string
  utilizationPercent?: number
  memoryUsedBytes?: number
  memoryTotalBytes?: number
  temperatureC?: number
  powerWatts?: number
}

export interface ComputeEngineAggregate {
  cpuPercent: number
  coresAllocated: number
  hostCores: number
  throttledCount: number
  memUsed: number
  memLimit: number
  diskUsed: number
  rxBytes: number
  txBytes: number
  sampledCount: number
  oldestSampleAgeSeconds: number
  runningJobs?: number
  runningFreeJobs?: number
  queuedJobs?: number
  queuedFreeJobs?: number
  gpus: ComputeGpuAggregate[]
}

export type EnvResourceSnapshot = Record<
  string,
  Record<string, { total: number; inUse: number }>
>
