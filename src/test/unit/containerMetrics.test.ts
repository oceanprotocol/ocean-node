import { expect } from 'chai'
import {
  buildSnapshot,
  getMetricsIntervalSeconds,
  isMetricsCollectionEnabled,
  isSnapshotStale,
  RawContainerSample
} from '../../components/c2d/containerMetrics.js'
import { parseMemoryTotalToBytes } from '../../components/c2d/gpu/types.js'
import { NvmlGpuCollector } from '../../components/c2d/gpu/nvml.js'
import {
  omitDBComputeFieldsFromComputeJob,
  sanitizePublicMetrics
} from '../../components/c2d/index.js'
import {
  toPublicServiceJob,
  toListedServiceJob
} from '../../components/core/service/utils.js'
import type {
  ContainerMetricsSnapshot,
  DBComputeJob,
  ComputeResource
} from '../../@types/C2D/C2D.js'
import type { ServiceJob } from '../../@types/C2D/ServiceOnDemand.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

const MB = 1024 * 1024
const GB = 1024 * MB

// A cgroup-v2-shaped Docker stats blob (one-shot: no precpu_stats).
function cgroupV2Stats(overrides: any = {}): any {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 2e9 },
      system_cpu_usage: 20e9,
      online_cpus: 4,
      throttling_data: { throttled_periods: 5, throttled_time: 2e9 }
    },
    memory_stats: {
      usage: 500 * MB,
      limit: 1024 * MB,
      stats: { inactive_file: 100 * MB }
    },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 1000 },
        { op: 'Write', value: 2000 }
      ]
    },
    networks: { eth0: { rx_bytes: 111, tx_bytes: 222 } },
    pids_stats: { current: 7 },
    ...overrides
  }
}

function runningState(overrides: any = {}): any {
  return {
    Status: 'running',
    Running: true,
    StartedAt: '2026-07-28T10:00:00Z',
    OOMKilled: false,
    ExitCode: 0,
    RestartCount: 0,
    ...overrides
  }
}

const ALLOC = { cpu: 2, ramBytes: 1024 * MB, diskBytes: 10 * GB }

describe('containerMetrics.buildSnapshot', () => {
  it('computes CPU % from the previous accumulator (one-shot deltas)', () => {
    const prev: Partial<ContainerMetricsSnapshot> = {
      collectedAt: '2026-07-28T10:00:00Z',
      prev: { cpuTotal: 1e9, systemCpu: 10e9, sampledAt: '2026-07-28T10:00:00Z' }
    }
    const raw: RawContainerSample = { stats: cgroupV2Stats(), state: runningState() }
    const snap = buildSnapshot(raw, prev as ContainerMetricsSnapshot, ALLOC, 5 * GB)
    // Δcpu=1e9, Δsys=10e9, cpus=4 → 0.1*4*100 = 40%
    expect(snap.cpu.usagePercent).to.equal(40)
    expect(snap.cpu.usagePercentOfAllocated).to.equal(20) // 40 / 2 cores
    expect(snap.cpu.cumulativeSeconds).to.equal(2) // 2e9 ns
    expect(snap.cpu.throttledPeriods).to.equal(5)
    expect(snap.cpu.throttledSeconds).to.equal(2)
  })

  it('reports 0% CPU on a true first sample (no prev, no precpu)', () => {
    const raw: RawContainerSample = { stats: cgroupV2Stats(), state: runningState() }
    const snap = buildSnapshot(raw, undefined, ALLOC, 5 * GB)
    expect(snap.cpu.usagePercent).to.equal(0)
    // but it still records the accumulator for the next sample
    expect(snap.prev?.cpuTotal).to.equal(2e9)
    expect(snap.prev?.systemCpu).to.equal(20e9)
  })

  it('subtracts inactive_file for memory (cgroup v2 convention) and uses allocated limit', () => {
    const raw: RawContainerSample = { stats: cgroupV2Stats(), state: runningState() }
    const snap = buildSnapshot(raw, undefined, ALLOC, 5 * GB)
    expect(snap.memory.usageBytes).to.equal(400 * MB) // 500 - 100 inactive
    expect(snap.memory.limitBytes).to.equal(1024 * MB) // from allocation
    expect(snap.memory.usagePercent).to.be.closeTo(39.06, 0.1)
  })

  it('tracks the memory peak across samples (cgroup v2 has no max_usage)', () => {
    const prev = {
      collectedAt: '2026-07-28T10:00:00Z',
      memory: { usageBytes: 0, limitBytes: 0, usagePercent: 0, peakUsageBytes: 600 * MB }
    } as ContainerMetricsSnapshot
    const raw: RawContainerSample = { stats: cgroupV2Stats(), state: runningState() }
    const snap = buildSnapshot(raw, prev, ALLOC, 5 * GB)
    // current usage 400MB < previous peak 600MB → peak retained
    expect(snap.memory.peakUsageBytes).to.equal(600 * MB)
  })

  it('reports disk usage vs quota when a disk allocation is present', () => {
    const raw: RawContainerSample = { stats: cgroupV2Stats(), state: runningState() }
    const snap = buildSnapshot(raw, undefined, ALLOC, 5 * GB)
    expect(snap.disk.usedBytes).to.equal(5 * GB)
    expect(snap.disk.quotaBytes).to.equal(10 * GB)
    expect(snap.disk.usagePercent).to.equal(50)
  })

  it('falls back to SizeRw for disk when no du() figure is supplied (services)', () => {
    const raw: RawContainerSample = {
      stats: cgroupV2Stats(),
      state: runningState({ SizeRw: 3 * MB })
    }
    const snap = buildSnapshot(
      raw,
      undefined,
      { cpu: 1, ramBytes: 0, diskBytes: 0 },
      undefined
    )
    expect(snap.disk.usedBytes).to.equal(3 * MB)
    expect(snap.disk.quotaBytes).to.equal(undefined)
  })

  it('omits the network field when the container has no networks (NetworkMode none)', () => {
    const raw: RawContainerSample = {
      stats: cgroupV2Stats({ networks: undefined }),
      state: runningState()
    }
    const snap = buildSnapshot(raw, undefined, ALLOC, 0)
    expect(snap.network).to.equal(undefined)
  })

  it('sums block IO and network across interfaces', () => {
    const raw: RawContainerSample = {
      stats: cgroupV2Stats({
        networks: {
          eth0: { rx_bytes: 100, tx_bytes: 200 },
          eth1: { rx_bytes: 11, tx_bytes: 22 }
        }
      }),
      state: runningState()
    }
    const snap = buildSnapshot(raw, undefined, ALLOC, 0)
    expect(snap.network).to.deep.equal({ rxBytes: 111, txBytes: 222 })
    expect(snap.blockIO).to.deep.equal({ readBytes: 1000, writeBytes: 2000 })
    expect(snap.pids.current).to.equal(7)
    expect(snap.pids.limit).to.equal(512)
  })

  it('captures structured container exit info (OOM / exit code)', () => {
    const raw: RawContainerSample = {
      stats: cgroupV2Stats(),
      state: runningState({
        Status: 'exited',
        Running: false,
        OOMKilled: true,
        ExitCode: 137,
        FinishedAt: '2026-07-28T10:05:00Z'
      })
    }
    const snap = buildSnapshot(raw, undefined, ALLOC, 0)
    expect(snap.containerState.oomKilled).to.equal(true)
    expect(snap.containerState.exitCode).to.equal(137)
    expect(snap.containerState.status).to.equal('exited')
    expect(snap.containerState.finishedAt).to.equal('2026-07-28T10:05:00Z')
  })

  it('tolerates cgroup v1 field drift / missing fields without throwing', () => {
    // cgroup v1-ish: no online_cpus, percpu list present, memory.stats.cache instead of inactive_file
    const raw: RawContainerSample = {
      stats: {
        cpu_stats: {
          cpu_usage: { total_usage: 5e9, percpu_usage: [1, 1] },
          system_cpu_usage: 50e9,
          throttling_data: {}
        },
        memory_stats: { usage: 200 * MB, limit: 512 * MB, stats: { cache: 50 * MB } }
      },
      state: runningState()
    }
    const prev = {
      collectedAt: '2026-07-28T10:00:00Z',
      prev: { cpuTotal: 4e9, systemCpu: 40e9, sampledAt: '2026-07-28T10:00:00Z' }
    } as ContainerMetricsSnapshot
    const snap = buildSnapshot(raw, prev, { cpu: 1, ramBytes: 0, diskBytes: 0 }, 0)
    // Δcpu=1e9, Δsys=10e9, cpus inferred from percpu_usage length = 2 → 0.1*2*100 = 20%
    expect(snap.cpu.usagePercent).to.equal(20)
    expect(snap.memory.usageBytes).to.equal(150 * MB) // 200 - 50 cache
    expect(snap.blockIO).to.deep.equal({ readBytes: 0, writeBytes: 0 })
    expect(snap.network).to.equal(undefined)
  })
})

describe('containerMetrics config helpers', () => {
  const original = ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value
  afterEach(() => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = original
  })

  it('defaults the interval to 10s', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = undefined
    expect(getMetricsIntervalSeconds()).to.equal(10)
    expect(isMetricsCollectionEnabled()).to.equal(true)
  })

  it('treats 0 as disabled', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = '0'
    expect(getMetricsIntervalSeconds()).to.equal(0)
    expect(isMetricsCollectionEnabled()).to.equal(false)
  })

  it('falls back to the default on invalid input', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = 'abc'
    expect(getMetricsIntervalSeconds()).to.equal(10)
  })

  it('respects a custom cadence', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = '30'
    expect(getMetricsIntervalSeconds()).to.equal(30)
  })
})

describe('containerMetrics.isSnapshotStale', () => {
  const now = new Date('2026-07-28T10:00:30Z').getTime()
  it('is stale when there is no previous snapshot', () => {
    expect(isSnapshotStale(undefined, 10, now)).to.equal(true)
  })
  it('is stale when older than the interval', () => {
    const prev = { collectedAt: '2026-07-28T10:00:15Z' } as ContainerMetricsSnapshot
    expect(isSnapshotStale(prev, 10, now)).to.equal(true) // 15s old ≥ 10s
  })
  it('is fresh when within the interval', () => {
    const prev = { collectedAt: '2026-07-28T10:00:25Z' } as ContainerMetricsSnapshot
    expect(isSnapshotStale(prev, 10, now)).to.equal(false) // 5s old < 10s
  })
})

describe('gpu parseMemoryTotalToBytes', () => {
  it('parses MiB / GiB / GB strings', () => {
    expect(parseMemoryTotalToBytes('3072 MiB')).to.equal(3072 * 1024 * 1024)
    expect(parseMemoryTotalToBytes('16 GiB')).to.equal(16 * 1024 ** 3)
    expect(parseMemoryTotalToBytes('8GB')).to.equal(8e9)
  })
  it('returns undefined for absent/garbage input', () => {
    expect(parseMemoryTotalToBytes(undefined)).to.equal(undefined)
    expect(parseMemoryTotalToBytes('lots')).to.equal(undefined)
  })
})

describe('gpu NVML multi-GPU resolution + sampling', () => {
  const gpuResource = (id: string, uuid: string): ComputeResource => ({
    id,
    type: 'gpu',
    kind: 'discrete',
    platform: 'nvidia',
    memoryTotal: '3072 MiB',
    total: 1,
    min: 0,
    max: 1,
    init: {
      deviceRequests: { Driver: 'nvidia', DeviceIDs: [uuid], Capabilities: [['gpu']] }
    }
  })

  it('resolves each GPU resource to its own handle (pinned by NVML UUID)', () => {
    const collector = new NvmlGpuCollector()
    const h0 = collector.resolve(gpuResource('gpu0', 'GPU-aaaa'))
    const h1 = collector.resolve(gpuResource('gpu1', 'GPU-bbbb'))
    expect(h0?.resourceId).to.equal('gpu0')
    expect(h0?.uuid).to.equal('GPU-aaaa')
    expect(h0?.memoryTotalBytes).to.equal(3072 * 1024 * 1024)
    expect(h1?.uuid).to.equal('GPU-bbbb')
  })

  it('samples every held device — one entry per GPU (multi-GPU job)', async () => {
    const collector: any = new NvmlGpuCollector()
    // Inject a fake NVML binding layer (no real libnvidia-ml on CI): each getter fills its
    // out-param and returns NVML_SUCCESS (0). Utilization keyed off the UUID so the two
    // devices produce distinct numbers.
    const utilByUuid: Record<string, number> = { 'GPU-aaaa': 11, 'GPU-bbbb': 77 }
    let currentUuid = ''
    collector.detected = true
    collector.initialized = true
    collector.bindings = {
      getHandleByUUID: (uuid: string, out: any[]) => {
        currentUuid = uuid
        out[0] = { uuid }
        return 0
      },
      getUtilizationRates: (_dev: any, util: any) => {
        util.gpu = utilByUuid[currentUuid]
        util.memory = 0
        return 0
      },
      getMemoryInfo: (_dev: any, mem: any) => {
        mem.used = 1024 * MB
        mem.total = 3072 * MB
        return 0
      },
      getTemperature: (_dev: any, _s: number, out: any[]) => {
        out[0] = 55
        return 0
      },
      getPowerUsage: (_dev: any, out: any[]) => {
        out[0] = 90000 // mW
        return 0
      }
    }
    const handles = [
      collector.resolve(gpuResource('gpu0', 'GPU-aaaa')),
      collector.resolve(gpuResource('gpu1', 'GPU-bbbb'))
    ]
    const metrics = await collector.sample(handles)
    expect(metrics).to.have.length(2)
    expect(metrics[0].resourceId).to.equal('gpu0')
    expect(metrics[0].utilizationPercent).to.equal(11)
    expect(metrics[0].memoryUsedBytes).to.equal(1024 * MB)
    expect(metrics[0].powerWatts).to.equal(90)
    expect(metrics[1].resourceId).to.equal('gpu1')
    expect(metrics[1].utilizationPercent).to.equal(77)
  })
})

describe('runtimeMetrics is stripped from every public shape (default)', () => {
  // A snapshot carrying the internal `prev` accumulator, which must never surface publicly.
  const snapshot = {
    collectedAt: '2026-07-28T10:00:00Z',
    containerState: { status: 'running', oomKilled: false, restartCount: 0 },
    cpu: {
      usagePercent: 40,
      allocated: 2,
      usagePercentOfAllocated: 20,
      cumulativeSeconds: 1,
      throttledPeriods: 0,
      throttledSeconds: 0
    },
    prev: { cpuTotal: 1e9, systemCpu: 10e9, sampledAt: '2026-07-28T10:00:00Z' }
  } as ContainerMetricsSnapshot

  it('omitDBComputeFieldsFromComputeJob drops runtimeMetrics by default (status + escrow proof)', () => {
    const dbJob = {
      jobId: 'job-1',
      owner: '0xabc',
      runtimeMetrics: snapshot,
      clusterHash: 'h',
      resources: []
    } as unknown as DBComputeJob
    const pub = omitDBComputeFieldsFromComputeJob(dbJob)
    expect('runtimeMetrics' in (pub as any)).to.equal(false)
    // and it must not appear in the serialized escrow-proof form either
    expect(JSON.stringify(pub)).to.not.contain('runtimeMetrics')
  })

  it('toPublicServiceJob and toListedServiceJob drop runtimeMetrics by default', () => {
    const svc = {
      serviceId: 's-1',
      owner: '0xabc',
      userData: 'enc',
      runtimeMetrics: snapshot
    } as unknown as ServiceJob
    const pub = toPublicServiceJob(svc)
    const listed = toListedServiceJob(svc)
    expect('runtimeMetrics' in (pub as any)).to.equal(false)
    expect('runtimeMetrics' in (listed as any)).to.equal(false)
  })
})

describe('runtimeMetrics opt-in exposure (owner status path)', () => {
  const snapshot = {
    collectedAt: '2026-07-28T10:00:00Z',
    containerState: { status: 'running', oomKilled: false, restartCount: 0 },
    cpu: {
      usagePercent: 40,
      allocated: 2,
      usagePercentOfAllocated: 20,
      cumulativeSeconds: 1,
      throttledPeriods: 0,
      throttledSeconds: 0
    },
    prev: { cpuTotal: 1e9, systemCpu: 10e9, sampledAt: '2026-07-28T10:00:00Z' }
  } as ContainerMetricsSnapshot

  it('sanitizePublicMetrics drops the internal prev accumulator', () => {
    const pub = sanitizePublicMetrics(snapshot)
    expect(pub).to.not.equal(undefined)
    expect('prev' in (pub as any)).to.equal(false)
    expect(pub!.cpu.usagePercent).to.equal(40) // real metrics retained
  })

  it('omitDBComputeFieldsFromComputeJob keeps sanitized metrics with { includeMetrics: true }', () => {
    const dbJob = {
      jobId: 'job-1',
      owner: '0xabc',
      runtimeMetrics: snapshot,
      clusterHash: 'h',
      resources: []
    } as unknown as DBComputeJob
    const pub = omitDBComputeFieldsFromComputeJob(dbJob, { includeMetrics: true })
    expect((pub as any).runtimeMetrics).to.not.equal(undefined)
    // still strips other internal fields, and the exposed snapshot drops `prev`
    expect('clusterHash' in (pub as any)).to.equal(false)
    expect('prev' in (pub as any).runtimeMetrics).to.equal(false)
    expect((pub as any).runtimeMetrics.cpu.usagePercent).to.equal(40)
  })

  it('the escrow-proof (default) shape stays metrics-free regardless', () => {
    const dbJob = {
      jobId: 'job-1',
      owner: '0xabc',
      runtimeMetrics: snapshot,
      resources: []
    } as unknown as DBComputeJob
    // Default call = the proof shape at compute_engine_docker.ts
    const proof = JSON.stringify(omitDBComputeFieldsFromComputeJob(dbJob))
    expect(proof).to.not.contain('runtimeMetrics')
    expect(proof).to.not.contain('"prev"')
  })

  it('toPublicServiceJob keeps sanitized metrics with { includeMetrics: true } but still strips userData', () => {
    const svc = {
      serviceId: 's-1',
      owner: '0xabc',
      userData: 'enc',
      runtimeMetrics: snapshot
    } as unknown as ServiceJob
    const pub = toPublicServiceJob(svc, { includeMetrics: true }) as any
    expect(pub.runtimeMetrics).to.not.equal(undefined)
    expect('prev' in pub.runtimeMetrics).to.equal(false)
    expect('userData' in pub).to.equal(false)
    // the node-wide listing shape never exposes metrics, even now
    expect('runtimeMetrics' in (toListedServiceJob(svc) as any)).to.equal(false)
  })
})
