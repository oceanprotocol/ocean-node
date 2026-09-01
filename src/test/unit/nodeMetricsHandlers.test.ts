import { expect } from 'chai'
import { Readable } from 'stream'
import {
  GetNodeMetricsHandler,
  GetNodeMetricsHistoryHandler
} from '../../components/core/handler/nodeMetrics.js'
import { PROTOCOL_COMMANDS, ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import {
  GetNodeMetricsCommand,
  GetNodeMetricsHistoryCommand
} from '../../@types/commands.js'
import {
  NodeMetricsDatabase,
  floorToHour
} from '../../components/database/sqliteNodeMetrics.js'
import type { NodeMetricsSnapshot } from '../../@types/nodeMetrics.js'
import { getConfiguration } from '../../utils/config.js'
import { OceanNode } from '../../OceanNode.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  getMetricsRetentionDays,
  isNodeMetricsHistoryEnabled
} from '../../utils/cronjobs/nodeMetricsJobs.js'

async function streamToJson(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.from(c))
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

function baseSnapshot(overrides: Partial<NodeMetricsSnapshot> = {}): NodeMetricsSnapshot {
  return {
    collectedAt: Date.now(),
    hasAggregate: true,
    cpu: {
      usagePercent: 10,
      coresAllocated: 2,
      hostCores: 8,
      throttledCount: 0,
      loadAverage: []
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

// Spies on getHourly() so param clamping/capping can be asserted without needing thousands of
// real rows in the DB.
class SpyingNodeMetricsDatabase extends NodeMetricsDatabase {
  public lastCall: { from: number; to: number; limit: number } | undefined
  getHourly(from: number, to: number, limit: number) {
    this.lastCall = { from, to, limit }
    return super.getHourly(from, to, limit)
  }
}

describe('nodeMetrics handlers', () => {
  let node: OceanNode
  let tempDir: string
  let metricsDb: SpyingNodeMetricsDatabase

  before(async () => {
    const config = await getConfiguration()
    const keyManager = new KeyManager(config)
    node = OceanNode.getInstance(config, null, null, null, null, keyManager, null, true)
  })

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-metrics-handler-test-'))
    metricsDb = new SpyingNodeMetricsDatabase(path.join(tempDir, 'nodeMetrics.sqlite'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('GetNodeMetricsHandler (live snapshot)', () => {
    it('returns a 200 well-formed snapshot even with no C2D engines configured', async () => {
      const command: GetNodeMetricsCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS
      }
      const result = await new GetNodeMetricsHandler(node).handle(command)
      expect(result.status.httpStatus).to.equal(200)
      const snapshot = await streamToJson(result.stream as Readable)
      expect(snapshot.hasAggregate).to.equal(false)
      expect(snapshot.cpu).to.be.an('object')
      expect(snapshot.gpu).to.deep.equal([])
    })
  })

  describe('GetNodeMetricsHistoryHandler (param parse/validate/clamp/cap)', () => {
    function nodeWithMetricsDb(): OceanNode {
      // Override getDatabase() to hand back only what the handler reads (db.nodeMetrics),
      // avoiding any dependency on a real metadata DB or the shared repo-level SQLite files.
      const fakeNode = Object.create(node)
      fakeNode.getDatabase = () => Promise.resolve({ nodeMetrics: metricsDb })
      return fakeNode as OceanNode
    }

    it('returns 503 when node metrics history is not available on this node', async () => {
      const bareNode = Object.create(node)
      bareNode.getDatabase = () => Promise.resolve({ nodeMetrics: undefined as any })
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY
      }
      const result = await new GetNodeMetricsHistoryHandler(bareNode).handle(command)
      expect(result.status.httpStatus).to.equal(503)
      expect(result.status.error).to.contain('not available')
    })

    it('defaults to the last retention window → now when no params given', async () => {
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY
      }
      const before = Date.now()
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      expect(result.status.httpStatus).to.equal(200)
      const body = await streamToJson(result.stream as Readable)
      expect(body.stopTime).to.be.at.least(before)
      const expectedRetentionMs = 180 * 24 * 60 * 60 * 1000
      expect(body.startTime).to.be.closeTo(body.stopTime - expectedRetentionMs, 5000)
      expect(body.buckets).to.deep.equal([])
      expect(body.count).to.equal(0)
    })

    it('rejects startTime >= stopTime', async () => {
      const now = Date.now()
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        startTime: now,
        stopTime: now - 1000
      }
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      expect(result.status.httpStatus).to.equal(400)
      expect(result.status.error).to.contain('startTime must be earlier than stopTime')
    })

    it('rejects an unparseable startTime', async () => {
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        startTime: 'not-a-date'
      }
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      expect(result.status.httpStatus).to.equal(400)
      expect(result.status.error).to.contain('Invalid startTime')
    })

    it('rejects an unparseable stopTime', async () => {
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        stopTime: 'garbage'
      }
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      expect(result.status.httpStatus).to.equal(400)
      expect(result.status.error).to.contain('Invalid stopTime')
    })

    it('accepts epoch-ms numeric strings and ISO date strings', async () => {
      // Recent (well within the retention window) so neither bound gets clamped.
      const stop = Date.now() - 60 * 60 * 1000
      const start = stop - 24 * 60 * 60 * 1000
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        startTime: String(start),
        stopTime: new Date(stop).toISOString()
      }
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      expect(result.status.httpStatus).to.equal(200)
      const body = await streamToJson(result.stream as Readable)
      expect(body.startTime).to.equal(start)
      expect(body.stopTime).to.equal(stop)
    })

    it('clamps a startTime older than the retention window to the retention boundary', async () => {
      const now = Date.now()
      const tooOld = now - 400 * 24 * 60 * 60 * 1000 // > 180 days back
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        startTime: tooOld,
        stopTime: now
      }
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      expect(result.status.httpStatus).to.equal(200)
      const body = await streamToJson(result.stream as Readable)
      const earliest = now - 180 * 24 * 60 * 60 * 1000
      expect(body.startTime).to.be.closeTo(earliest, 5000)
      expect(body.startTime).to.be.greaterThan(tooOld)
    })

    it('clamps a stopTime in the future to now', async () => {
      const now = Date.now()
      const future = now + 10_000_000
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        startTime: now - 1000,
        stopTime: future
      }
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      const body = await streamToJson(result.stream as Readable)
      expect(body.stopTime).to.be.at.most(Date.now())
      expect(body.stopTime).to.be.lessThan(future)
    })

    it('caps the row limit passed to the database at MAX_HISTORY_ROWS (10000)', async () => {
      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY
      }
      await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(command)
      expect(metricsDb.lastCall?.limit).to.equal(10000)
    })

    it('returns real hourly buckets stored in the database within the requested range', async () => {
      // Use a recent hour (a few hours before "now") so it stays inside the retention window.
      const hour = floorToHour(Date.now() - 5 * 60 * 60 * 1000)
      metricsDb.insertSample(baseSnapshot({ collectedAt: hour + 1000 }))
      metricsDb.rollupHour(hour)

      const command: GetNodeMetricsHistoryCommand = {
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        startTime: hour - 1000,
        stopTime: hour + 60 * 60 * 1000
      }
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle(
        command
      )
      const body = await streamToJson(result.stream as Readable)
      expect(body.count).to.equal(1)
      expect(body.buckets[0].hourStart).to.equal(hour)
      expect(body.buckets[0].cpu.usagePercent).to.equal(10)
    })

    it('keeps the echoed range ordered when the whole window predates retention', async () => {
      // Both bounds are older than the 180-day retention horizon; clamping would otherwise pull
      // start (up to `earliest`) past stop, echoing an inverted startTime > stopTime.
      const day = 24 * 60 * 60 * 1000
      const now = Date.now()
      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle({
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY,
        startTime: now - 300 * day,
        stopTime: now - 200 * day
      })
      expect(result.status.httpStatus).to.equal(200)
      const body = await streamToJson(result.stream as Readable)
      expect(body.startTime).to.be.at.most(body.stopTime)
      expect(body.count).to.equal(0)
      expect(body.buckets).to.deep.equal([])
    })

    it('appends a live partial:true bucket for the current, not-yet-rolled-up hour', async () => {
      // Raw samples in the CURRENT hour, deliberately NOT rolled up.
      const currentHour = floorToHour(Date.now())
      metricsDb.insertSample(
        baseSnapshot({
          collectedAt: currentHour + 1000,
          cpu: { ...baseSnapshot().cpu, usagePercent: 40 }
        })
      )
      metricsDb.insertSample(
        baseSnapshot({
          collectedAt: currentHour + 2000,
          cpu: { ...baseSnapshot().cpu, usagePercent: 60 }
        })
      )

      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle({
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY
      })
      const body = await streamToJson(result.stream as Readable)
      const last = body.buckets[body.buckets.length - 1]
      expect(last.hourStart).to.equal(currentHour)
      expect(last.partial).to.equal(true)
      expect(last.sampleCount).to.equal(2)
      expect(last.cpu.usagePercent).to.equal(50) // mean(40, 60)
    })

    it('does not append a partial bucket when the current hour has already been rolled up', async () => {
      const currentHour = floorToHour(Date.now())
      metricsDb.insertSample(baseSnapshot({ collectedAt: currentHour + 1000 }))
      metricsDb.rollupHour(currentHour) // stored → no partial should be added on top

      const result = await new GetNodeMetricsHistoryHandler(nodeWithMetricsDb()).handle({
        command: PROTOCOL_COMMANDS.GET_NODE_METRICS_HISTORY
      })
      const body = await streamToJson(result.stream as Readable)
      const currentHourBuckets = body.buckets.filter(
        (b: { hourStart: number }) => b.hourStart === currentHour
      )
      expect(currentHourBuckets).to.have.length(1)
      expect(currentHourBuckets[0].partial).to.equal(undefined)
    })
  })
})

describe('nodeMetricsJobs config helpers', () => {
  const originalRetention = ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value
  const originalEnabled = ENVIRONMENT_VARIABLES.NODE_METRICS_HISTORY_ENABLED.value
  afterEach(() => {
    ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value = originalRetention
    ENVIRONMENT_VARIABLES.NODE_METRICS_HISTORY_ENABLED.value = originalEnabled
  })

  describe('getMetricsRetentionDays', () => {
    it('defaults to 180 when unset', () => {
      ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value = undefined
      expect(getMetricsRetentionDays()).to.equal(180)
    })

    it('respects a configured value', () => {
      ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value = '30'
      expect(getMetricsRetentionDays()).to.equal(30)
    })

    it('falls back to the default on invalid input (non-numeric, zero, negative)', () => {
      ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value = 'abc'
      expect(getMetricsRetentionDays()).to.equal(180)
      ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value = '0'
      expect(getMetricsRetentionDays()).to.equal(180)
      ENVIRONMENT_VARIABLES.NODE_METRICS_RETENTION_DAYS.value = '-5'
      expect(getMetricsRetentionDays()).to.equal(180)
    })
  })

  describe('isNodeMetricsHistoryEnabled', () => {
    it('defaults to enabled when unset', () => {
      ENVIRONMENT_VARIABLES.NODE_METRICS_HISTORY_ENABLED.value = undefined
      expect(isNodeMetricsHistoryEnabled()).to.equal(true)
    })

    it('treats "false"/"0"/"no" as disabled', () => {
      for (const v of ['false', '0', 'no', 'FALSE', 'No']) {
        ENVIRONMENT_VARIABLES.NODE_METRICS_HISTORY_ENABLED.value = v
        expect(isNodeMetricsHistoryEnabled(), `value=${v}`).to.equal(false)
      }
    })

    it('treats any other value as enabled', () => {
      ENVIRONMENT_VARIABLES.NODE_METRICS_HISTORY_ENABLED.value = 'true'
      expect(isNodeMetricsHistoryEnabled()).to.equal(true)
    })
  })
})
