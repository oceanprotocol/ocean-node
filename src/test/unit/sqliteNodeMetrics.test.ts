import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  NodeMetricsDatabase,
  floorToHour
} from '../../components/database/sqliteNodeMetrics.js'
import type { NodeMetricsSnapshot } from '../../@types/nodeMetrics.js'

function baseSnapshot(overrides: Partial<NodeMetricsSnapshot> = {}): NodeMetricsSnapshot {
  return {
    collectedAt: Date.now(),
    hasAggregate: true,
    cpu: {
      usagePercent: 10,
      coresAllocated: 2,
      hostCores: 8,
      throttledCount: 0,
      loadAverage: [0.1, 0.2, 0.3]
    },
    memory: {
      usedBytes: 100,
      limitBytes: 1000,
      hostFreeBytes: 500,
      hostTotalBytes: 2000
    },
    disk: { usedBytes: 300 },
    network: { rxBytes: 10, txBytes: 20 },
    jobs: { running: 1, runningFree: 0, queued: 0, queuedFree: 0 },
    gpu: [],
    env: [],
    meta: { sampledContainers: 1, oldestSampleAgeSeconds: 5 },
    ...overrides
  }
}

describe('sqliteNodeMetrics.floorToHour', () => {
  it('floors to the UTC hour boundary', () => {
    const t = Date.UTC(2026, 6, 28, 10, 37, 42, 123) // 2026-07-28T10:37:42.123Z
    const floored = floorToHour(t)
    expect(floored).to.equal(Date.UTC(2026, 6, 28, 10, 0, 0, 0))
  })

  it('is idempotent on an already-floored hour', () => {
    const t = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    expect(floorToHour(t)).to.equal(t)
  })
})

describe('NodeMetricsDatabase (temp SQLite file)', () => {
  let dbPath: string
  let db: NodeMetricsDatabase

  beforeEach(() => {
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'node-metrics-test-')),
      'nodeMetrics.sqlite'
    )
    db = new NodeMetricsDatabase(dbPath)
  })

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  it('rollupHour averages scalars and records sampleCount', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 60_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 10 }
      })
    )
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 120_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 30 }
      })
    )
    const rolled = db.rollupHour(hour)
    expect(rolled).to.equal(true)

    const rows = db.getHourly(hour, hour, 10)
    expect(rows).to.have.length(1)
    expect(rows[0].hourStart).to.equal(hour)
    expect(rows[0].sampleCount).to.equal(2)
    expect(rows[0].cpu.usagePercent).to.equal(20) // mean(10, 30)
  })

  it('rollupHour on an empty hour returns false and writes no row', () => {
    const hour = Date.UTC(2026, 6, 28, 11, 0, 0, 0)
    const rolled = db.rollupHour(hour)
    expect(rolled).to.equal(false)
    expect(db.getHourly(hour, hour, 10)).to.have.length(0)
  })

  it('rollupHour only consumes samples within [hourStart, hourStart+1h) — partial-hour boundary', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    const nextHour = hour + 60 * 60 * 1000
    db.insertSample(baseSnapshot({ collectedAt: hour + 1000 })) // inside hour
    db.insertSample(baseSnapshot({ collectedAt: nextHour + 1000 })) // next hour, must not roll in
    db.rollupHour(hour)
    // the sample belonging to the next hour must still be present (not consumed)
    const pending = db.getPendingSampleHours(nextHour + 60 * 60 * 1000)
    expect(pending).to.include(nextHour)
    expect(pending).to.not.include(hour)
  })

  it('rollupHour deletes the consumed raw samples after averaging', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    db.insertSample(baseSnapshot({ collectedAt: hour + 1000 }))
    db.rollupHour(hour)
    // nothing left in that hour to roll up again (idempotent-ish: no samples, so returns false)
    expect(db.rollupHour(hour)).to.equal(false)
  })

  it('rollupHour is upsert: re-rolling an hourStart overwrites rather than duplicates', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 1000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 10 }
      })
    )
    db.rollupHour(hour)
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 2000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 90 }
      })
    )
    db.rollupHour(hour)
    const rows = db.getHourly(hour, hour, 10)
    expect(rows).to.have.length(1)
    expect(rows[0].cpu.usagePercent).to.equal(90)
    expect(rows[0].sampleCount).to.equal(1)
  })

  it('averages GPU metrics per resourceId and env resources per env+resource', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 1000,
        gpu: [
          {
            resourceId: 'gpu0',
            vendor: 'nvidia',
            utilizationPercent: 20,
            memoryUsedBytes: 100
          }
        ],
        env: [{ env: 'envA', resource: 'cpu', total: 4, inUse: 2 }]
      })
    )
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 2000,
        gpu: [
          {
            resourceId: 'gpu0',
            vendor: 'nvidia',
            utilizationPercent: 80,
            memoryUsedBytes: 300
          }
        ],
        env: [{ env: 'envA', resource: 'cpu', total: 4, inUse: 4 }]
      })
    )
    db.rollupHour(hour)
    const [row] = db.getHourly(hour, hour, 10)
    expect(row.gpu).to.have.length(1)
    expect(row.gpu[0].resourceId).to.equal('gpu0')
    expect(row.gpu[0].utilizationPercent).to.equal(50) // mean(20, 80)
    expect(row.gpu[0].memoryUsedBytes).to.equal(200) // mean(100, 300)
    expect(row.env).to.have.length(1)
    expect(row.env[0].inUse).to.equal(3) // mean(2, 4)
  })

  it('GPUs present in only some samples do not have their mean dragged down by absent samples', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    // gpu0 reports temperatureC only on the second sample
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 1000,
        gpu: [{ resourceId: 'gpu0', utilizationPercent: 10 }]
      })
    )
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 2000,
        gpu: [{ resourceId: 'gpu0', utilizationPercent: 30, temperatureC: 60 }]
      })
    )
    db.rollupHour(hour)
    const [row] = db.getHourly(hour, hour, 10)
    expect(row.gpu[0].utilizationPercent).to.equal(20) // mean over 2 samples
    expect(row.gpu[0].temperatureC).to.equal(60) // mean over 1 sample that reported it, not 30
  })

  it('purgeOldSamples deletes samples older than the cutoff and returns the count', () => {
    const now = Date.now()
    db.insertSample(baseSnapshot({ collectedAt: now - 4 * 60 * 60 * 1000 })) // old
    db.insertSample(baseSnapshot({ collectedAt: now })) // recent
    const purged = db.purgeOldSamples(now - 3 * 60 * 60 * 1000)
    expect(purged).to.equal(1)
  })

  it('deleteHourlyOlderThan enforces retention and returns the count deleted', () => {
    const oldHour = Date.UTC(2020, 0, 1)
    const recentHour = floorToHour(Date.now())
    db.insertSample(baseSnapshot({ collectedAt: oldHour + 1000 }))
    db.rollupHour(oldHour)
    db.insertSample(baseSnapshot({ collectedAt: recentHour + 1000 }))
    db.rollupHour(recentHour)

    const deleted = db.deleteHourlyOlderThan(Date.now() - 180 * 24 * 60 * 60 * 1000)
    expect(deleted).to.equal(1)
    const remaining = db.getHourly(0, Date.now(), 1000)
    expect(remaining).to.have.length(1)
    expect(remaining[0].hourStart).to.equal(recentHour)
  })

  it('getHourly returns ordered buckets within range, capped at limit', () => {
    const h0 = Date.UTC(2026, 6, 28, 8, 0, 0, 0)
    const h1 = h0 + 60 * 60 * 1000
    const h2 = h1 + 60 * 60 * 1000
    for (const h of [h0, h1, h2]) {
      db.insertSample(baseSnapshot({ collectedAt: h + 1000 }))
      db.rollupHour(h)
    }
    const rows = db.getHourly(h0, h2, 2)
    expect(rows).to.have.length(2)
    expect(rows[0].hourStart).to.equal(h0)
    expect(rows[1].hourStart).to.equal(h1)
  })

  it('JSON round-trips gpu/env through storage (safeParse recovers structured fields)', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 1000,
        gpu: [{ resourceId: 'gpu0', vendor: 'nvidia', powerWatts: 88 }],
        env: [{ env: 'envA', resource: 'gpu0', total: 1, inUse: 1 }]
      })
    )
    db.rollupHour(hour)
    const [row] = db.getHourly(hour, hour, 10)
    expect(row.gpu[0]).to.include({
      resourceId: 'gpu0',
      vendor: 'nvidia',
      powerWatts: 88
    })
    expect(row.env[0]).to.deep.equal({
      env: 'envA',
      resource: 'gpu0',
      total: 1,
      inUse: 1
    })
  })

  it('getPartialHour averages the raw (un-rolled) samples and flags partial:true', () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 60_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 10 }
      })
    )
    db.insertSample(
      baseSnapshot({
        collectedAt: hour + 120_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 30 }
      })
    )
    const partial = db.getPartialHour(hour)
    expect(partial).to.not.equal(null)
    expect(partial!.partial).to.equal(true)
    expect(partial!.hourStart).to.equal(hour)
    expect(partial!.sampleCount).to.equal(2)
    expect(partial!.cpu.usagePercent).to.equal(20) // mean(10, 30) — same averaging as rollupHour
  })

  it('getPartialHour returns null when the hour has no samples, and does not consume samples', () => {
    const hour = Date.UTC(2026, 6, 28, 12, 0, 0, 0)
    expect(db.getPartialHour(hour)).to.equal(null)
    // it is read-only: a sample in a populated hour survives a getPartialHour call
    db.insertSample(baseSnapshot({ collectedAt: hour + 1000 }))
    expect(db.getPartialHour(hour)!.sampleCount).to.equal(1)
    expect(db.getPartialHour(hour)!.sampleCount).to.equal(1)
  })
})
