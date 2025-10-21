import { expect } from 'chai'
import { Readable } from 'stream'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { GetJobsHandler } from '../../components/core/handler/getJobs.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  type DBComputeJob
} from '../../@types/C2D/C2D.js'
import { PROTOCOL_COMMANDS, getConfiguration } from '../../utils/index.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { streamToObject } from '../../utils/util.js'

// Helper to create a minimal valid DBComputeJob
function buildJob(overrides: Partial<DBComputeJob> = {}): DBComputeJob {
  const nowSec = Math.floor(Date.now() / 1000).toString()
  return {
    owner: overrides.owner || '0xowner_test',
    did: overrides.did,
    jobId: overrides.jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    dateCreated: overrides.dateCreated || nowSec,
    dateFinished: overrides.dateFinished || (null as unknown as string),
    status: overrides.status ?? C2DStatusNumber.JobStarted,
    statusText: overrides.statusText || C2DStatusText.JobStarted,
    results: overrides.results || [],
    inputDID: overrides.inputDID,
    algoDID: overrides.algoDID,
    maxJobDuration: overrides.maxJobDuration,
    agreementId: overrides.agreementId,
    environment: overrides.environment || 'env-default',
    metadata: overrides.metadata,
    terminationDetails: overrides.terminationDetails,

    clusterHash: overrides.clusterHash || '',
    configlogURL: overrides.configlogURL || '',
    publishlogURL: overrides.publishlogURL || '',
    algologURL: overrides.algologURL || '',
    outputsURL: overrides.outputsURL || '',
    stopRequested: overrides.stopRequested ?? false,
    algorithm: overrides.algorithm as any,
    assets: overrides.assets || [],
    isRunning: overrides.isRunning ?? false,
    isStarted: overrides.isStarted ?? true,
    containerImage: overrides.containerImage || '',
    isFree: overrides.isFree ?? true,
    algoStartTimestamp: overrides.algoStartTimestamp || nowSec,
    algoStopTimestamp: overrides.algoStopTimestamp || nowSec,
    resources: overrides.resources || [],
    payment: overrides.payment,
    additionalViewers: overrides.additionalViewers || [],
    algoDuration: overrides.algoDuration || 0
  }
}

describe('GetJobsHandler integration', () => {
  let previousConfiguration: OverrideEnvConfig[]
  let oceanNode: OceanNode
  let db: Database
  let handler: GetJobsHandler

  const uniqueEnv = `env-it-${Date.now()}`
  const ownerA = '0xAa0000000000000000000000000000000000000'
  const ownerB = '0xBb0000000000000000000000000000000000000'

  before(async () => {
    previousConfiguration = await setupEnvironment(TEST_ENV_CONFIG_FILE)
    const config = await getConfiguration(true)
    db = await Database.init(config.dbConfig)
    oceanNode = await OceanNode.getInstance(config, db)

    handler = new GetJobsHandler(oceanNode)

    const jobA = buildJob({ owner: ownerA, environment: uniqueEnv })
    const jobB = buildJob({ owner: ownerB, environment: uniqueEnv })

    await db.c2d.newJob(jobA)
    await db.c2d.newJob(jobB)

    const finishedAt = Math.floor(Date.now() / 1000).toString()

    jobA.status = C2DStatusNumber.JobFinished
    jobA.statusText = C2DStatusText.JobFinished
    jobA.dateFinished = finishedAt
    jobA.isRunning = false

    jobB.status = C2DStatusNumber.JobFinished
    jobB.statusText = C2DStatusText.JobFinished
    jobB.dateFinished = finishedAt
    jobB.isRunning = false

    await db.c2d.updateJob(jobA)
    await db.c2d.updateJob(jobB)
  })

  after(async () => {
    await tearDownEnvironment(previousConfiguration)
  })

  it('validate should fail when fromTimestamp is not a string', async () => {
    const validation = await handler.validate({
      command: PROTOCOL_COMMANDS.JOBS,
      fromTimestamp: 12345
    } as any)
    expect(validation.valid).to.be.equal(false)
    expect(validation.reason).to.contain('fromTimestamp')
  })

  it('should return finished jobs for a specific environment since timestamp', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT)

    const fromTs = Math.floor(Date.now() / 1000 - 10).toString()
    const resp = await handler.handle({
      command: PROTOCOL_COMMANDS.JOBS,
      environments: [uniqueEnv],
      fromTimestamp: fromTs
    })

    expect(resp.status.httpStatus).to.equal(200)
    const jobs = (await streamToObject(resp.stream as Readable)) as any[]

    const filtered = jobs.filter((j) => j.environment === uniqueEnv)
    expect(filtered.length).to.be.greaterThanOrEqual(2)
    expect(filtered.every((j) => Number(j.dateFinished) >= Number(fromTs))).to.equal(true)
  })

  it('should exclude jobs owned by specified consumer addresses', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT)

    const resp = await handler.handle({
      command: PROTOCOL_COMMANDS.JOBS,
      environments: [uniqueEnv],
      consumerAddrs: [ownerA]
    })

    expect(resp.status.httpStatus).to.equal(200)
    const jobs = (await streamToObject(resp.stream as Readable)) as any[]

    const owners = jobs.filter((j) => j.environment === uniqueEnv).map((j) => j.owner)
    expect(owners.includes(ownerA)).to.equal(false)
    expect(owners.includes(ownerB)).to.equal(true)
  })
})
