import { expect } from 'chai'
import { Client } from '@elastic/elasticsearch'
import { floorToHour } from '../../components/database/nodeMetricsAggregate.js'
import { ElasticsearchNodeMetrics } from '../../components/database/ElasticsearchNodeMetrics.js'
import {
  createElasticsearchClientWithRetry,
  searchAllPages
} from '../../components/database/ElasticsearchConfigHelper.js'
import { getConfiguration } from '../../utils/index.js'
import type { NodeMetricsSnapshot } from '../../@types/nodeMetrics.js'

const INSTANCE = 'test-instance'
const OTHER_INSTANCE = 'other-instance'

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

describe('nodeMetricsAggregate.floorToHour', () => {
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

describe('ElasticsearchNodeMetrics', () => {
  let db: ElasticsearchNodeMetrics
  let client: Client

  before(async () => {
    const { dbConfig } = await getConfiguration()
    db = await ElasticsearchNodeMetrics.create(dbConfig)
    client = await createElasticsearchClientWithRetry(dbConfig)
  })

  // sample inserts use refresh: 'wait_for', so no index refresh is needed first
  beforeEach(async () => {
    await client.deleteByQuery({
      index: ['node_metrics_samples', 'node_metrics_hourly'],
      query: { match_all: {} },
      refresh: true,
      conflicts: 'proceed'
    })
  })

  it('rollupHour averages scalars and records sampleCount', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 60_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 10 }
      })
    )
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 120_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 30 }
      })
    )
    const rolled = await db.rollupHour(INSTANCE, hour)
    expect(rolled).to.equal(true)

    const rows = await db.getHourly(INSTANCE, hour, hour, 10)
    expect(rows).to.have.length(1)
    expect(rows[0].hourStart).to.equal(hour)
    expect(rows[0].sampleCount).to.equal(2)
    expect(rows[0].cpu.usagePercent).to.equal(20) // mean(10, 30)
  })

  it('rollupHour on an empty hour returns false and writes no row', async () => {
    const hour = Date.UTC(2026, 6, 28, 11, 0, 0, 0)
    const rolled = await db.rollupHour(INSTANCE, hour)
    expect(rolled).to.equal(false)
    expect(await db.getHourly(INSTANCE, hour, hour, 10)).to.have.length(0)
  })

  it('rollupHour only consumes samples within [hourStart, hourStart+1h) — partial-hour boundary', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    const nextHour = hour + 60 * 60 * 1000
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: hour + 1000 })) // inside hour
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: nextHour + 1000 })) // next hour, must not roll in
    await db.rollupHour(INSTANCE, hour)
    // the sample belonging to the next hour must still be present (not consumed)
    const pending = await db.getPendingSampleHours(INSTANCE, nextHour + 60 * 60 * 1000)
    expect(pending).to.include(nextHour)
    expect(pending).to.not.include(hour)
  })

  it('rollupHour deletes the consumed raw samples after averaging', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: hour + 1000 }))
    await db.rollupHour(INSTANCE, hour)
    // nothing left in that hour to roll up again (idempotent-ish: no samples, so returns false)
    expect(await db.rollupHour(INSTANCE, hour)).to.equal(false)
  })

  it('rollupHour is upsert: re-rolling an hourStart overwrites rather than duplicates', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 1000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 10 }
      })
    )
    await db.rollupHour(INSTANCE, hour)
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 2000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 90 }
      })
    )
    await db.rollupHour(INSTANCE, hour)
    const rows = await db.getHourly(INSTANCE, hour, hour, 10)
    expect(rows).to.have.length(1)
    expect(rows[0].cpu.usagePercent).to.equal(90)
    expect(rows[0].sampleCount).to.equal(1)
  })

  it('rollupHour twice for the same hour returns true both times and keeps one row', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: hour + 1000 }))
    expect(await db.rollupHour(INSTANCE, hour)).to.equal(true)
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: hour + 2000 }))
    expect(await db.rollupHour(INSTANCE, hour)).to.equal(true)
    expect(await db.getHourly(INSTANCE, hour, hour, 10)).to.have.length(1)
  })

  it('a second instance sees none of the first instance samples or hourly rows', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    const nextHour = hour + 60 * 60 * 1000
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: hour + 1000 }))
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: nextHour + 1000 }))
    await db.rollupHour(INSTANCE, hour)

    expect(await db.getPendingSampleHours(OTHER_INSTANCE, nextHour * 2)).to.deep.equal([])
    expect(await db.getPartialHour(OTHER_INSTANCE, nextHour)).to.equal(null)
    expect(await db.getHourly(OTHER_INSTANCE, 0, nextHour, 10)).to.deep.equal([])
    expect(await db.rollupHour(OTHER_INSTANCE, nextHour)).to.equal(false)
    expect(await db.purgeOldSamples(OTHER_INSTANCE, nextHour * 2)).to.equal(0)
    expect(await db.deleteHourlyOlderThan(OTHER_INSTANCE, nextHour * 2)).to.equal(0)

    expect(await db.getHourly(INSTANCE, 0, nextHour, 10)).to.have.length(1)
    expect(await db.getPendingSampleHours(INSTANCE, nextHour * 2)).to.deep.equal([
      nextHour
    ])
  })

  it('averages GPU metrics per resourceId and env resources per env+resource', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    await db.insertSample(
      INSTANCE,
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
    await db.insertSample(
      INSTANCE,
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
    await db.rollupHour(INSTANCE, hour)
    const [row] = await db.getHourly(INSTANCE, hour, hour, 10)
    expect(row.gpu).to.have.length(1)
    expect(row.gpu[0].resourceId).to.equal('gpu0')
    expect(row.gpu[0].utilizationPercent).to.equal(50) // mean(20, 80)
    expect(row.gpu[0].memoryUsedBytes).to.equal(200) // mean(100, 300)
    expect(row.env).to.have.length(1)
    expect(row.env[0].inUse).to.equal(3) // mean(2, 4)
  })

  it('GPUs present in only some samples do not have their mean dragged down by absent samples', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    // gpu0 reports temperatureC only on the second sample
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 1000,
        gpu: [{ resourceId: 'gpu0', utilizationPercent: 10 }]
      })
    )
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 2000,
        gpu: [{ resourceId: 'gpu0', utilizationPercent: 30, temperatureC: 60 }]
      })
    )
    await db.rollupHour(INSTANCE, hour)
    const [row] = await db.getHourly(INSTANCE, hour, hour, 10)
    expect(row.gpu[0].utilizationPercent).to.equal(20) // mean over 2 samples
    expect(row.gpu[0].temperatureC).to.equal(60) // mean over 1 sample that reported it, not 30
  })

  it('searchAllPages reads every match across pages, in order', async () => {
    const start = Date.now() - 5 * 60 * 1000
    for (let i = 0; i < 5; i++) {
      await db.insertSample(
        INSTANCE,
        baseSnapshot({ collectedAt: start + i * 60 * 1000 })
      )
    }
    // page size 2 -> three pages for five samples
    const hits = await searchAllPages<{ collectedAt: number }>(
      client,
      {
        index: 'node_metrics_samples',
        query: { term: { instanceId: INSTANCE } },
        sort: [{ collectedAt: { order: 'asc' } }],
        _source: ['collectedAt']
      },
      2
    )
    expect(hits.map((hit) => hit._source.collectedAt)).to.deep.equal(
      [0, 1, 2, 3, 4].map((i) => start + i * 60 * 1000)
    )
  })

  it('purgeOldSamples deletes samples older than the cutoff and returns the count', async () => {
    const now = Date.now()
    await db.insertSample(
      INSTANCE,
      baseSnapshot({ collectedAt: now - 4 * 60 * 60 * 1000 })
    ) // old
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: now })) // recent
    const purged = await db.purgeOldSamples(INSTANCE, now - 3 * 60 * 60 * 1000)
    expect(purged).to.equal(1)
  })

  it('deleteHourlyOlderThan enforces retention and returns the count deleted', async () => {
    const oldHour = Date.UTC(2020, 0, 1)
    const recentHour = floorToHour(Date.now())
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: oldHour + 1000 }))
    await db.rollupHour(INSTANCE, oldHour)
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: recentHour + 1000 }))
    await db.rollupHour(INSTANCE, recentHour)

    const deleted = await db.deleteHourlyOlderThan(
      INSTANCE,
      Date.now() - 180 * 24 * 60 * 60 * 1000
    )
    expect(deleted).to.equal(1)
    const remaining = await db.getHourly(INSTANCE, 0, Date.now(), 1000)
    expect(remaining).to.have.length(1)
    expect(remaining[0].hourStart).to.equal(recentHour)
  })

  it('getHourly returns ordered buckets within range, capped at limit', async () => {
    const h0 = Date.UTC(2026, 6, 28, 8, 0, 0, 0)
    const h1 = h0 + 60 * 60 * 1000
    const h2 = h1 + 60 * 60 * 1000
    for (const h of [h0, h1, h2]) {
      await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: h + 1000 }))
      await db.rollupHour(INSTANCE, h)
    }
    const rows = await db.getHourly(INSTANCE, h0, h2, 2)
    expect(rows).to.have.length(2)
    expect(rows[0].hourStart).to.equal(h0)
    expect(rows[1].hourStart).to.equal(h1)
  })

  it('JSON round-trips gpu/env through storage (safeParse recovers structured fields)', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 1000,
        gpu: [{ resourceId: 'gpu0', vendor: 'nvidia', powerWatts: 88 }],
        env: [{ env: 'envA', resource: 'gpu0', total: 1, inUse: 1 }]
      })
    )
    await db.rollupHour(INSTANCE, hour)
    const [row] = await db.getHourly(INSTANCE, hour, hour, 10)
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

  it('getPartialHour averages the raw (un-rolled) samples and flags partial:true', async () => {
    const hour = Date.UTC(2026, 6, 28, 10, 0, 0, 0)
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 60_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 10 }
      })
    )
    await db.insertSample(
      INSTANCE,
      baseSnapshot({
        collectedAt: hour + 120_000,
        cpu: { ...baseSnapshot().cpu, usagePercent: 30 }
      })
    )
    const partial = await db.getPartialHour(INSTANCE, hour)
    expect(partial).to.not.equal(null)
    expect(partial!.partial).to.equal(true)
    expect(partial!.hourStart).to.equal(hour)
    expect(partial!.sampleCount).to.equal(2)
    expect(partial!.cpu.usagePercent).to.equal(20) // mean(10, 30) — same averaging as rollupHour
  })

  it('getPartialHour returns null when the hour has no samples, and does not consume samples', async () => {
    const hour = Date.UTC(2026, 6, 28, 12, 0, 0, 0)
    expect(await db.getPartialHour(INSTANCE, hour)).to.equal(null)
    // it is read-only: a sample in a populated hour survives a getPartialHour call
    await db.insertSample(INSTANCE, baseSnapshot({ collectedAt: hour + 1000 }))
    expect((await db.getPartialHour(INSTANCE, hour))!.sampleCount).to.equal(1)
    expect((await db.getPartialHour(INSTANCE, hour))!.sampleCount).to.equal(1)
  })
})
