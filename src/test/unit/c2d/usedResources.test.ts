import { assert, expect } from 'chai'
import sinon from 'sinon'
import { Readable } from 'stream'
import {
  C2DClusterType,
  C2DStatusNumber,
  ComputeEnvironment,
  ComputeJob,
  DBComputeJob
} from '../../../@types/C2D/C2D.js'
import {
  C2DEngine,
  parseJobTimestamp
} from '../../../components/c2d/compute_engine_base.js'
import { C2DDatabase } from '../../../components/database/C2DDatabase.js'
import { ValidateParams } from '../../../components/httpRoutes/validateCommands.js'
import { ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'

const CLUSTER_HASH = '0xcluster'
const ENV_ID = 'test-env'
// Frozen clock, so every remaining-time assertion can be exact instead of tolerance-based.
const NOW_SEC = 1785760660
const NOW_MS = NOW_SEC * 1000

/* eslint-disable require-await */
class TestEngine extends C2DEngine {
  constructor(jobs: DBComputeJob[], serviceJobs: ServiceJob[] = []) {
    super(
      { type: C2DClusterType.DOCKER, hash: CLUSTER_HASH },
      {
        getRunningJobs: () => Promise.resolve(jobs),
        getRunningServiceJobs: () => Promise.resolve(serviceJobs)
      } as unknown as C2DDatabase,
      null,
      null,
      null
    )
  }

  async getComputeEnvironments(): Promise<ComputeEnvironment[]> {
    return []
  }

  async checkDockerImage(): Promise<ValidateParams> {
    return { valid: true, reason: null as string, status: 200 }
  }

  async startComputeJob(): Promise<ComputeJob[]> {
    return []
  }

  async stopComputeJob(): Promise<ComputeJob[]> {
    return []
  }

  async getComputeJobStatus(): Promise<ComputeJob[]> {
    return []
  }

  async getComputeJobResult(): Promise<{ stream: Readable; headers: any }> {
    return null
  }

  async cleanupExpiredStorage(): Promise<boolean> {
    return true
  }
}
/* eslint-enable require-await */

function makeEnv(): ComputeEnvironment {
  return {
    id: ENV_ID,
    resources: [
      { id: 'cpu', kind: 'fungible', type: 'cpu', total: 64, max: 64, min: 1, inUse: 0 },
      { id: 'ram', kind: 'fungible', type: 'ram', total: 62, max: 62, min: 1, inUse: 0 }
    ],
    runningJobs: 0,
    runningfreeJobs: 0,
    queuedJobs: 0,
    queuedFreeJobs: 0,
    queMaxWaitTime: 0,
    queMaxWaitTimeFree: 0,
    runMaxWaitTime: 0,
    runMaxWaitTimeFree: 0,
    consumerAddress: '0x0',
    fees: {},
    access: { addresses: [], accessLists: null },
    platform: { architecture: 'x86_64', os: 'linux' },
    minJobDuration: 60,
    maxJobDuration: 3600,
    maxJobs: 20
  } as unknown as ComputeEnvironment
}

function makeJob(overrides: Partial<DBComputeJob> = {}): DBComputeJob {
  return {
    clusterHash: CLUSTER_HASH,
    jobId: 'job-1',
    owner: '0xowner',
    environment: ENV_ID,
    status: C2DStatusNumber.RunningAlgorithm,
    maxJobDuration: 3600,
    queueMaxWaitTime: 0,
    isFree: false,
    isRunning: true,
    dateCreated: String(NOW_SEC),
    // both timestamps default to the '0' sentinel exactly as newJob() writes them
    buildStartTimestamp: '0',
    algoStartTimestamp: '0',
    resources: [
      { id: 'cpu', amount: 2 },
      { id: 'ram', amount: 4 }
    ],
    ...overrides
  } as unknown as DBComputeJob
}

async function used(jobs: DBComputeJob[], serviceJobs: ServiceJob[] = []) {
  return await new TestEngine(jobs, serviceJobs).getUsedResources(makeEnv())
}

describe('parseJobTimestamp', () => {
  it("returns 0 for the '0' sentinel and for missing / malformed values", () => {
    // '0' is truthy: this is the whole reason the helper exists
    expect(parseJobTimestamp('0')).to.equal(0)
    expect(parseJobTimestamp('0.0')).to.equal(0)
    expect(parseJobTimestamp('')).to.equal(0)
    expect(parseJobTimestamp(undefined)).to.equal(0)
    expect(parseJobTimestamp(null as unknown as string)).to.equal(0)
    expect(parseJobTimestamp('abc')).to.equal(0)
    expect(parseJobTimestamp('-5')).to.equal(0)
  })

  it('returns the parsed value for a real timestamp', () => {
    expect(parseJobTimestamp('1785760660.961')).to.equal(1785760660.961)
  })
})

describe('C2DEngine.getUsedResources', () => {
  let clock: sinon.SinonStub

  beforeEach(() => {
    clock = sinon.stub(Date, 'now').returns(NOW_MS)
  })

  afterEach(() => {
    clock.restore()
  })

  it('reports the full budget for a job with both timestamps still at the sentinel', async () => {
    const res = await used([makeJob()])
    assert(res.maxRunningTime === 3600, `expected 3600, got ${res.maxRunningTime}`)
    assert(res.totalJobs === 1, `expected 1 running job, got ${res.totalJobs}`)
  })

  it('does not report an epoch-sized negative for 15 sentinel jobs (reported bug)', async () => {
    const jobs = Array.from({ length: 15 }, (_, i) => makeJob({ jobId: `job-${i}` }))
    const res = await used(jobs)
    // pre-fix this was -26786355914.46 (15 × (3600 - now))
    assert(res.maxRunningTime > 0, `must never be negative, got ${res.maxRunningTime}`)
    // sum semantics: 15 jobs × full 3600s budget
    assert(res.maxRunningTime === 54000, `expected 54000, got ${res.maxRunningTime}`)
    assert(res.totalJobs === 15, `expected 15 running jobs, got ${res.totalJobs}`)
  })

  it('uses algoStartTimestamp when buildStartTimestamp is the sentinel (pull path)', async () => {
    // The sharpest case: pre-fix the truthy '0' shadowed this valid timestamp and the
    // remaining time came out around -1.79e9.
    const res = await used([
      makeJob({ buildStartTimestamp: '0', algoStartTimestamp: String(NOW_SEC - 100) })
    ])
    assert(res.maxRunningTime === 3500, `expected 3500, got ${res.maxRunningTime}`)
  })

  it('prefers buildStartTimestamp when both are set (build time counts to the budget)', async () => {
    const res = await used([
      makeJob({
        buildStartTimestamp: String(NOW_SEC - 100),
        algoStartTimestamp: String(NOW_SEC - 10)
      })
    ])
    assert(res.maxRunningTime === 3500, `expected 3500, got ${res.maxRunningTime}`)
  })

  it('clamps an overdue job to 0 instead of publishing a negative', async () => {
    const res = await used([
      makeJob({ algoStartTimestamp: String(NOW_SEC - 7200), maxJobDuration: 3600 })
    ])
    assert(res.maxRunningTime === 0, `expected 0, got ${res.maxRunningTime}`)
  })

  it('treats malformed timestamps as not-yet-started, never NaN', async () => {
    for (const bad of ['abc', '', undefined, '-100']) {
      const res = await used([
        makeJob({ buildStartTimestamp: bad, algoStartTimestamp: bad })
      ])
      assert(
        !Number.isNaN(res.maxRunningTime),
        `maxRunningTime must not be NaN for ${JSON.stringify(bad)}`
      )
      assert(
        res.maxRunningTime === 3600,
        `expected 3600 for ${JSON.stringify(bad)}, got ${res.maxRunningTime}`
      )
    }
  })

  it('counts a JobQueued job as queued, with no resources held', async () => {
    const res = await used([
      makeJob({
        status: C2DStatusNumber.JobQueued,
        queueMaxWaitTime: 600,
        dateCreated: String(NOW_SEC - 100)
      })
    ])
    assert(res.queuedJobs === 1, `expected 1 queued job, got ${res.queuedJobs}`)
    assert(res.totalJobs === 0, `expected 0 running jobs, got ${res.totalJobs}`)
    // remaining queue wait, not the runtime budget: 600 - 100
    assert(res.maxWaitTime === 500, `expected 500, got ${res.maxWaitTime}`)
    expect(res.usedResources).to.deep.equal({})
  })

  it('reports the full queue wait for a queued job with no usable dateCreated', async () => {
    const res = await used([
      makeJob({
        status: C2DStatusNumber.JobQueued,
        queueMaxWaitTime: 600,
        dateCreated: '0'
      })
    ])
    assert(res.maxWaitTime === 600, `expected 600, got ${res.maxWaitTime}`)
  })

  it('counts a released job (queueMaxWaitTime > 0, status running) as running and holding resources', async () => {
    // Regression test for the queueMaxWaitTime-as-liveness-flag bug: queueMaxWaitTime is
    // never reset on release, so this job used to stay in queuedJobs forever with its
    // cpu/ram invisible to the availability gate.
    const res = await used([
      makeJob({
        status: C2DStatusNumber.RunningAlgorithm,
        queueMaxWaitTime: 600,
        algoStartTimestamp: String(NOW_SEC - 100)
      })
    ])
    assert(res.totalJobs === 1, `expected 1 running job, got ${res.totalJobs}`)
    assert(res.queuedJobs === 0, `expected 0 queued jobs, got ${res.queuedJobs}`)
    assert(res.maxRunningTime === 3500, `expected 3500, got ${res.maxRunningTime}`)
    expect(res.usedResources).to.deep.equal({ cpu: 2, ram: 4 })
  })

  it('counts mid-pipeline states (PullImage/BuildImage/ConfiguringVolumes) as holding resources', async () => {
    for (const status of [
      C2DStatusNumber.PullImage,
      C2DStatusNumber.BuildImage,
      C2DStatusNumber.ConfiguringVolumes
    ]) {
      const res = await used([makeJob({ status })])
      expect(res.usedResources, `status ${status}`).to.deep.equal({ cpu: 2, ram: 4 })
      assert(res.totalJobs === 1, `status ${status}: expected 1 running job`)
    }
  })

  it('separates free from paid usage', async () => {
    const res = await used([
      makeJob({
        jobId: 'paid',
        algoStartTimestamp: String(NOW_SEC - 100),
        isFree: false
      }),
      makeJob({
        jobId: 'free',
        algoStartTimestamp: String(NOW_SEC - 600),
        isFree: true
      })
    ])
    expect(res.usedResources).to.deep.equal({ cpu: 4, ram: 8 })
    expect(res.usedFreeResources).to.deep.equal({ cpu: 2, ram: 4 })
    assert(res.totalJobs === 2, `expected 2 running jobs, got ${res.totalJobs}`)
    assert(res.totalFreeJobs === 1, `expected 1 free job, got ${res.totalFreeJobs}`)
    // paid+free: 3500 + 3000 ; free only: 3000
    assert(res.maxRunningTime === 6500, `expected 6500, got ${res.maxRunningTime}`)
    assert(
      res.maxRunningTimeFree === 3000,
      `expected 3000, got ${res.maxRunningTimeFree}`
    )
  })

  it('accumulates remaining runtime as a sum across running jobs', async () => {
    // Pins the documented (surprising) sum semantics so a refactor cannot silently switch
    // this field to a per-job maximum.
    const res = await used([
      makeJob({
        jobId: 'a',
        maxJobDuration: 3600,
        algoStartTimestamp: String(NOW_SEC - 3500)
      }),
      makeJob({
        jobId: 'b',
        maxJobDuration: 3600,
        algoStartTimestamp: String(NOW_SEC - 1600)
      }),
      makeJob({
        jobId: 'c',
        maxJobDuration: 3600,
        algoStartTimestamp: String(NOW_SEC - 600)
      })
    ])
    // 100 + 2000 + 3000
    assert(res.maxRunningTime === 5100, `expected 5100, got ${res.maxRunningTime}`)
  })
})

describe('C2DEngine.checkIfResourcesAreAvailable free-tier gate', () => {
  function envWithFree(freeResources: any[]): ComputeEnvironment {
    const env = makeEnv()
    env.resources[0].inUse = 0
    ;(env as any).free = {
      resources: freeResources,
      maxJobs: 100,
      access: { addresses: [], accessLists: null }
    }
    return env
  }

  async function rejectionOf(promise: Promise<any>): Promise<string | null> {
    try {
      await promise
      return null
    } catch (e) {
      return e.message
    }
  }

  it('rejects an oversized free request when the free resource has no total/inUse', async () => {
    // A sparse free-resource entry made `undefined - undefined < amount` evaluate to NaN <
    // amount === false, silently passing the gate and allowing unlimited free allocation.
    const engine = new TestEngine([])
    for (const freeRes of [
      [{ id: 'cpu' }],
      [{ id: 'cpu', inUse: 4 }],
      [{ id: 'cpu', total: undefined as number, inUse: undefined as number }]
    ]) {
      const message = await rejectionOf(
        engine.checkIfResourcesAreAvailable(
          [{ id: 'cpu', amount: 8 }],
          envWithFree(freeRes),
          true
        )
      )
      assert(
        message === 'Not enough available cpu for free',
        `expected the free gate to reject ${JSON.stringify(freeRes)}, got ${message}`
      )
    }
  })

  it('still admits a request that fits the declared free capacity', async () => {
    const engine = new TestEngine([])
    const message = await rejectionOf(
      engine.checkIfResourcesAreAvailable(
        [{ id: 'cpu', amount: 8 }],
        envWithFree([{ id: 'cpu', total: 16, inUse: 4 }]),
        true
      )
    )
    assert(message === null, `expected no rejection, got ${message}`)
  })
})
