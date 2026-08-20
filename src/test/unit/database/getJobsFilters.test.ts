import { assert, expect } from 'chai'
import { C2DDatabase } from '../../../components/database/C2DDatabase.js'
import { typesenseSchemas } from '../../../components/database/TypesenseSchemas.js'
import { getConfiguration } from '../../../utils/config.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  ComputeAlgorithm,
  ComputeAsset,
  DBComputeJob
} from '../../../@types/C2D/C2D.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../../utils/utils.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import { GetJobsHandler } from '../../../components/core/handler/getJobs.js'
import { GetJobsCommand } from '../../../@types/commands.js'
import {
  parseFromTimestamp,
  parseFromTimestampSeconds
} from '../../../components/core/utils/timestamps.js'

// dateCreated/dateFinished are TEXT holding decimal seconds — the format the compute_jobs
// table actually stores. The fixture values are chosen so a lexicographic (memcmp)
// comparison gives a *different* answer than a numeric one for every input format below:
//
//   bound 1785760660 (s) / "1785760660000" (ms) / "2026-…" (ISO)
//   NEW_FINISHED "1785760660.961" — numerically above the bound, but as text below the ms
//                                   bound ('.' 0x2E < '0' 0x30 at index 10) and below ISO
//   NINE_DIGIT   "999999999.5"    — numerically far below the bound (year 2001), but as
//                                   text above every one of the three bounds ('9' > '1','2')
const BOUND_SEC = 1785760660
const OLD_SEC = BOUND_SEC - 7200
const NEW_FINISHED = '1785760660.961'
const NINE_DIGIT = '999999999.5'

// The C2D SQLite file survives between test runs, so every environment/jobId below is
// namespaced per run: each test then sees only the rows it seeded.
const RUN = String(Date.now())
const envName = (base: string) => `${base}-${RUN}`

const algorithm: ComputeAlgorithm = { documentId: 'did:op:1', serviceId: '0xabc' }
const dataset: ComputeAsset = { documentId: 'did:op:2', serviceId: '0xdef' }

function baseJob(overrides: Partial<DBComputeJob>): DBComputeJob {
  return {
    owner: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260',
    jobId: null,
    jobIdHash: null,
    dateCreated: null,
    dateFinished: null,
    status: C2DStatusNumber.JobFinished,
    statusText: C2DStatusText.JobFinished,
    results: null,
    inputDID: [],
    maxJobDuration: 3600,
    clusterHash: 'clusterHash',
    configlogURL: null,
    publishlogURL: null,
    algologURL: null,
    outputsURL: null,
    stopRequested: false,
    algorithm,
    assets: [dataset],
    isRunning: false,
    isStarted: false,
    containerImage: 'image',
    resources: [],
    environment: 'unset',
    agreementId: '0xagreement',
    isFree: false,
    algoStartTimestamp: '0',
    algoStopTimestamp: '0',
    algoDuration: 0,
    queueMaxWaitTime: 0,
    ...overrides
  } as unknown as DBComputeJob
}

describe('getJobs filters', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: C2DDatabase = null

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS],
      [
        '[{"socketPath":"/var/run/docker.sock","environments":[{"storageExpiry":604800,"maxJobDuration":3600,"minJobDuration":60,"resources":[{"id":"cpu","total":4,"max":4,"min":1,"type":"cpu"}],"fees":{"1":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]}}]}]'
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig, typesenseSchemas.c2dSchemas)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })

  // Seeds finished jobs into a run-private environment, with dateCreated == dateFinished so
  // one fixture serves both the fromTimestamp filter (dateFinished) and the ordering
  // assertion (dateCreated).
  async function seedFinished(envId: string, finishedSecs: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const [i, finished] of finishedSecs.entries()) {
      const jobId = await db.newJob(
        baseJob({
          jobId: `${envId}-${i}`,
          environment: envId,
          dateCreated: finished
        })
      )
      // dateFinished is only written by updateJob
      await db.updateJob(
        baseJob({
          jobId,
          environment: envId,
          dateCreated: finished,
          dateFinished: finished
        })
      )
      ids.push(jobId)
    }
    return ids
  }

  describe('fromTimestamp is compared numerically', () => {
    const envId = envName('env-fromTimestamp')

    before(async () => {
      await seedFinished(envId, [String(OLD_SEC), NINE_DIGIT, NEW_FINISHED])
    })

    // Only NEW_FINISHED is numerically at/after the bound, whichever format the caller used.
    async function expectOnlyTheNewRow(fromTimestamp: number) {
      const jobs = await db.getJobs([envId], fromTimestamp)
      assert(
        jobs.length === 1,
        `expected 1 job, got ${jobs.length}: ${jobs.map((j) => j.dateFinished).join()}`
      )
      assert(
        jobs[0].dateFinished === NEW_FINISHED,
        `expected ${NEW_FINISHED}, got ${jobs[0].dateFinished}`
      )
    }

    it('accepts Unix seconds — pre-fix this also matched the 9-digit row', async () => {
      await expectOnlyTheNewRow(BOUND_SEC)
    })

    it('accepts Unix milliseconds — pre-fix this missed the matching row', async () => {
      const fromTimestamp = parseFromTimestampSeconds(String(BOUND_SEC * 1000))
      await expectOnlyTheNewRow(fromTimestamp as number)
    })

    it('accepts an ISO date string — pre-fix this missed the matching row', async () => {
      const iso = new Date(BOUND_SEC * 1000).toISOString()
      const fromTimestamp = parseFromTimestampSeconds(iso)
      await expectOnlyTheNewRow(fromTimestamp as number)
    })

    it('returns everything when no fromTimestamp is given', async () => {
      const jobs = await db.getJobs([envId])
      assert(jobs.length === 3, `expected 3 jobs, got ${jobs.length}`)
    })
  })

  it('includes a row sitting exactly on the bound', async () => {
    const envId = envName('env-boundary')
    // the filter is >=, so an exact match must be returned
    await seedFinished(envId, [String(BOUND_SEC)])
    const jobs = await db.getJobs([envId], BOUND_SEC)
    assert(jobs.length === 1, `expected 1 job, got ${jobs.length}`)
  })

  it('orders by numeric dateCreated, not lexicographically', async () => {
    const envId = envName('env-ordering')
    // 9-digit vs 10-digit: as text "999999999.5" sorts above "1785760660.961", so pre-fix
    // the OLDER job came back first under ORDER BY dateCreated DESC.
    const tenDigits = NEW_FINISHED
    await seedFinished(envId, [NINE_DIGIT, tenDigits])
    const jobs = await db.getJobs([envId])
    assert(jobs.length === 2, `expected 2 jobs, got ${jobs.length}`)
    assert(
      jobs[0].dateCreated === tenDigits,
      `newest first: expected ${tenDigits}, got ${jobs[0].dateCreated}`
    )
  })

  describe('status filter', () => {
    const envId = envName('env-status')

    before(async () => {
      // JobStarted is 0 — the value a truthiness guard drops
      await db.newJob(
        baseJob({
          jobId: `${envId}-started`,
          environment: envId,
          status: C2DStatusNumber.JobStarted,
          statusText: C2DStatusText.JobStarted,
          dateCreated: String(BOUND_SEC)
        })
      )
      await db.newJob(
        baseJob({
          jobId: `${envId}-finished`,
          environment: envId,
          status: C2DStatusNumber.JobFinished,
          statusText: C2DStatusText.JobFinished,
          dateCreated: String(BOUND_SEC + 1)
        })
      )
    })

    it('filters on status 0 (JobStarted) — pre-fix this returned every status', async () => {
      const jobs = await db.getJobs(
        [envId],
        undefined,
        undefined,
        C2DStatusNumber.JobStarted
      )
      assert(jobs.length === 1, `expected 1 job, got ${jobs.length}`)
      assert(jobs[0].status === C2DStatusNumber.JobStarted)
    })

    it('filters on a non-zero status', async () => {
      const jobs = await db.getJobs(
        [envId],
        undefined,
        undefined,
        C2DStatusNumber.JobFinished
      )
      assert(jobs.length === 1, `expected 1 job, got ${jobs.length}`)
      assert(jobs[0].status === C2DStatusNumber.JobFinished)
    })

    it('does not treat an omitted status as a filter', async () => {
      const jobs = await db.getJobs([envId])
      assert(jobs.length === 2, `expected 2 jobs, got ${jobs.length}`)
    })
  })
})

describe('GetJobsHandler.validate fromTimestamp', () => {
  // validate() does not touch the node, so a null node is enough here
  const handler = new GetJobsHandler(null)

  function command(fromTimestamp?: any): GetJobsCommand {
    return {
      command: PROTOCOL_COMMANDS.JOBS,
      fromTimestamp
    } as GetJobsCommand
  }

  it('rejects an unparseable fromTimestamp instead of returning an empty list', () => {
    const result = handler.validate(command('abc'))
    assert(result.valid === false, 'expected validation to fail')
    assert(result.status === 400, `expected 400, got ${result.status}`)
    expect(result.reason).to.contain('not a valid date')
  })

  it('accepts seconds, milliseconds and ISO dates', () => {
    for (const value of [
      String(BOUND_SEC),
      String(BOUND_SEC * 1000),
      new Date(BOUND_SEC * 1000).toISOString()
    ]) {
      const result = handler.validate(command(value))
      assert(result.valid === true, `expected ${value} to be accepted`)
    }
  })

  it('treats an absent or empty fromTimestamp as no filter', () => {
    assert(handler.validate(command(undefined)).valid === true)
    assert(handler.validate(command('')).valid === true)
  })

  it('rejects a non-string fromTimestamp', () => {
    const result = handler.validate(command(12345))
    assert(result.valid === false, 'expected validation to fail')
  })
})

describe('timestamp query-parameter parsing', () => {
  it('distinguishes "no filter" from "unparseable"', () => {
    expect(parseFromTimestamp(undefined)).to.equal(undefined)
    expect(parseFromTimestamp('')).to.equal(undefined)
    expect(parseFromTimestamp('abc')).to.equal(null)
  })

  it('converts to seconds for the compute jobs table', () => {
    expect(parseFromTimestampSeconds(String(BOUND_SEC))).to.equal(BOUND_SEC)
    expect(parseFromTimestampSeconds(String(BOUND_SEC * 1000))).to.equal(BOUND_SEC)
    expect(parseFromTimestampSeconds(new Date(BOUND_SEC * 1000).toISOString())).to.equal(
      BOUND_SEC
    )
  })
})
