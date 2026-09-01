import { expect } from 'chai'
import {
  collectNodeMetricsSnapshot,
  hasFreshAggregate
} from '../../components/core/utils/nodeMetricsHandler.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import type { OceanNode } from '../../OceanNode.js'

// Minimal stand-in for the structural shape read by the collector (`lastAggregate` +
// `envResourceSnapshot` on each engine). Building a full C2DEngineDocker is unnecessary — the
// collector only reads these two fields structurally (see nodeMetricsHandler.ts comment).
function fakeNode(engines: any[]): OceanNode {
  return {
    getC2DEngines: () => ({
      getAllEngines: () => engines
    })
  } as unknown as OceanNode
}

function aggregate(overrides: any = {}) {
  return {
    cpuPercent: 10,
    coresAllocated: 2,
    throttledCount: 1,
    memUsed: 100,
    memLimit: 200,
    diskUsed: 300,
    rxBytes: 10,
    txBytes: 20,
    sampledCount: 3,
    oldestSampleAgeSeconds: 5,
    runningJobs: 1,
    runningFreeJobs: 0,
    queuedJobs: 0,
    queuedFreeJobs: 0,
    gpus: [],
    ...overrides
  }
}

describe('nodeMetricsHandler.collectNodeMetricsSnapshot', () => {
  const originalInterval = ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value
  afterEach(() => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = originalInterval
  })

  it('never throws and returns a well-formed zero snapshot when there are no engines', () => {
    const snapshot = collectNodeMetricsSnapshot(fakeNode([]))
    expect(snapshot.hasAggregate).to.equal(false)
    expect(snapshot.cpu.usagePercent).to.equal(0)
    expect(snapshot.memory.usedBytes).to.equal(0)
    expect(snapshot.gpu).to.deep.equal([])
    expect(snapshot.env).to.deep.equal([])
    expect(snapshot.collectedAt).to.be.a('number')
    // host reads are always populated, independent of the aggregate
    expect(snapshot.cpu.hostCores).to.be.greaterThan(0)
  })

  it('never throws when getC2DEngines is missing/throws', () => {
    const node = { getC2DEngines: undefined } as unknown as OceanNode
    const snapshot = collectNodeMetricsSnapshot(node)
    expect(snapshot.hasAggregate).to.equal(false)

    const throwing = {
      getC2DEngines: () => {
        throw new Error('boom')
      }
    } as unknown as OceanNode
    expect(() => collectNodeMetricsSnapshot(throwing)).to.not.throw()
  })

  it('sums scalar fields across engines and sets hasAggregate true', () => {
    const engines = [
      { lastAggregate: aggregate({ cpuPercent: 10, memUsed: 100 }) },
      { lastAggregate: aggregate({ cpuPercent: 25, memUsed: 400 }) }
    ]
    const snapshot = collectNodeMetricsSnapshot(fakeNode(engines))
    expect(snapshot.hasAggregate).to.equal(true)
    expect(snapshot.cpu.usagePercent).to.equal(35)
    expect(snapshot.memory.usedBytes).to.equal(500)
    expect(snapshot.meta.sampledContainers).to.equal(6)
    // takes the max, not sum, of oldestSampleAgeSeconds
    expect(snapshot.meta.oldestSampleAgeSeconds).to.equal(5)
  })

  it('dedupes GPUs across engines by resourceId (shared GPU not double-counted)', () => {
    const gpu0 = {
      resourceId: 'gpu0',
      vendor: 'nvidia',
      utilizationPercent: 50,
      memoryUsedBytes: 100,
      memoryTotalBytes: 1000,
      temperatureC: 60,
      powerWatts: 80
    }
    const gpu0Dup = { ...gpu0, utilizationPercent: 99 } // same resourceId, different reading
    const gpu1 = { ...gpu0, resourceId: 'gpu1' }
    const engines = [
      { lastAggregate: aggregate({ gpus: [gpu0, gpu1] }) },
      { lastAggregate: aggregate({ gpus: [gpu0Dup] }) }
    ]
    const snapshot = collectNodeMetricsSnapshot(fakeNode(engines))
    expect(snapshot.gpu).to.have.length(2)
    const ids = snapshot.gpu.map((g) => g.resourceId).sort()
    expect(ids).to.deep.equal(['gpu0', 'gpu1'])
    // first-seen wins (not overwritten by the duplicate on the second engine)
    const g0 = snapshot.gpu.find((g) => g.resourceId === 'gpu0')
    expect(g0.utilizationPercent).to.equal(50)
  })

  it('dedupes env resources by env+resource across engines', () => {
    const envSnap1 = { envA: { cpu: { total: 4, inUse: 2 } } }
    const envSnap2 = {
      envA: { cpu: { total: 999, inUse: 999 } },
      envB: { gpu: { total: 1, inUse: 0 } }
    }
    const engines = [
      { lastAggregate: aggregate(), envResourceSnapshot: envSnap1 },
      { lastAggregate: aggregate(), envResourceSnapshot: envSnap2 }
    ]
    const snapshot = collectNodeMetricsSnapshot(fakeNode(engines))
    expect(snapshot.env).to.have.length(2)
    const envA = snapshot.env.find((e) => e.env === 'envA' && e.resource === 'cpu')
    // first-seen wins, matching computeGauges.ts dedupe behavior
    expect(envA.total).to.equal(4)
    expect(envA.inUse).to.equal(2)
    const envB = snapshot.env.find((e) => e.env === 'envB' && e.resource === 'gpu')
    expect(envB.total).to.equal(1)
  })

  it('treats missing/null env resource entries defensively', () => {
    const engines = [
      {
        lastAggregate: aggregate(),
        envResourceSnapshot: { envA: { cpu: null as any } }
      }
    ]
    const snapshot = collectNodeMetricsSnapshot(fakeNode(engines))
    expect(snapshot.env).to.deep.equal([])
  })
})

describe('nodeMetricsHandler.hasFreshAggregate', () => {
  const originalInterval = ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value
  afterEach(() => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = originalInterval
  })

  it('is false when C2D_METRICS_INTERVAL_SECONDS=0 (collection disabled), even with an aggregate', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = '0'
    const engines = [{ lastAggregate: aggregate() }]
    expect(hasFreshAggregate(fakeNode(engines))).to.equal(false)
  })

  it('is false when collection is enabled but no engine has a lastAggregate yet', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = '10'
    const engines = [{}, { lastAggregate: undefined }]
    expect(hasFreshAggregate(fakeNode(engines))).to.equal(false)
  })

  it('is true when collection is enabled and at least one engine has a lastAggregate', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = '10'
    const engines = [{}, { lastAggregate: aggregate() }]
    expect(hasFreshAggregate(fakeNode(engines))).to.equal(true)
  })

  it('falls back to the default interval (10s → enabled) when unset', () => {
    ENVIRONMENT_VARIABLES.C2D_METRICS_INTERVAL_SECONDS.value = undefined
    const engines = [{ lastAggregate: aggregate() }]
    expect(hasFreshAggregate(fakeNode(engines))).to.equal(true)
  })
})
