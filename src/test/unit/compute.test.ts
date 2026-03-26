import { C2DDatabase } from '../../components/database/C2DDatabase.js'
// import { existsEnvironmentVariable, getConfiguration } from '../../utils/config.js'
import { getConfiguration } from '../../utils/config.js'
import { typesenseSchemas } from '../../components/database/TypesenseSchemas.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeEnvironment,
  ComputeJob,
  ComputeResourceRequest,
  DBComputeJob,
  RunningPlatform
} from '../../@types/C2D/C2D.js'
// import { computeAsset } from '../data/assets'
import { assert, expect } from 'chai'
import {
  convertArrayToString,
  convertStringToArray,
  STRING_SEPARATOR
} from '../../components/database/sqliteCompute.js'
import os from 'os'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { completeDBComputeJob, dockerImageManifest } from '../data/assets.js'
import {
  C2DEngine,
  omitDBComputeFieldsFromComputeJob
} from '../../components/c2d/index.js'
import { checkManifestPlatform } from '../../components/c2d/compute_engine_docker.js'
import { ValidateParams } from '../../components/httpRoutes/validateCommands.js'
import { Readable } from 'stream'

/* eslint-disable require-await */
class TestC2DEngine extends C2DEngine {
  constructor() {
    super(null, null, null, null, null)
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

function makeEnv(
  resources: any[],
  opts: {
    freeResources?: any[]
    runningJobs?: number
    runningfreeJobs?: number
    maxJobs?: number
  } = {}
): ComputeEnvironment {
  return {
    id: 'test-env',
    resources,
    free: opts.freeResources
      ? {
          resources: opts.freeResources,
          access: { addresses: [], accessLists: null }
        }
      : undefined,
    runningJobs: opts.runningJobs ?? 0,
    runningfreeJobs: opts.runningfreeJobs ?? 0,
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
    maxJobs: opts.maxJobs ?? 10
  }
}

describe('Compute Jobs Database', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: C2DDatabase = null
  let jobId: string = null
  const jobDuration = 60
  const algorithm: ComputeAlgorithm = {
    documentId: 'did:op:12345',
    serviceId: '0x1828228'
  }
  const dataset: ComputeAsset = {
    documentId: 'did:op:12345',
    serviceId: '0x12345abc'
  }

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS],
      [
        '[{"socketPath":"/var/run/docker.sock","resources":[{"id":"disk","total":10}],"storageExpiry":604800,"maxJobDuration":3600,"minJobDuration":60,"fees":{"1":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":60,"minJobDuration":10,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1},{"id":"disk","max":1}]}}]'
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig, typesenseSchemas.c2dSchemas)
  })

  it('should create a new C2D Job', async () => {
    const job: DBComputeJob = {
      owner: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260',
      jobId: null,
      jobIdHash: null,
      dateCreated: null,
      dateFinished: null,
      status: C2DStatusNumber.JobStarted,
      statusText: C2DStatusText.JobStarted,
      results: null,
      inputDID: ['did:op:1', 'did:op:2', 'did:op:3'],
      maxJobDuration: jobDuration,

      // internal structure
      clusterHash: 'clusterHash',
      configlogURL: 'http://localhost:8001',
      publishlogURL: 'http://localhost:8001',
      algologURL: 'http://localhost:8001',
      outputsURL: 'http://localhost:8001',
      stopRequested: false,
      algorithm,
      assets: [dataset],
      isRunning: false,
      isStarted: false,
      containerImage: 'some container image',
      resources: [],
      environment: 'some environment',
      agreementId: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
      payment: {
        token: '0x123',
        lockTx: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
        claimTx: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
        cancelTx: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
        chainId: 8996,
        cost: 0
      },
      isFree: false,
      algoStartTimestamp: '0',
      algoStopTimestamp: '0',
      algoDuration: 0,
      queueMaxWaitTime: 0
    }

    jobId = await db.newJob(job)
    assert(jobId, 'Missing jobId identifier')
  })

  it('should get job by jobId', async () => {
    const jobs = await db.getJob(jobId)
    assert(jobs.length === 1, 'Could not get any job')
    assert(jobs[0], 'Job should not be null')
    assert(jobs[0].jobId === jobId, 'JobId mismatches')
    assert(jobs[0].maxJobDuration === jobDuration, 'Job duration mismatches')
  })
  it('should update job', async () => {
    const jobs = await db.getJob(jobId)
    const job = jobs[0]
    // will update some fields
    job.status = C2DStatusNumber.PullImage
    job.isRunning = true
    job.statusText = C2DStatusText.PullImage

    // update on DB
    const updates = await db.updateJob(job)
    expect(updates).to.be.equal(1) // updated 1 row
    const updatedJobs = await db.getJob(jobId)
    const updatedJob = updatedJobs[0]
    assert(updatedJob, 'Job should not be null')
    expect(updatedJob.status).to.be.equal(C2DStatusNumber.PullImage)
    expect(updatedJob.isRunning).to.be.equal(true)
    expect(updatedJob.statusText).to.be.equal(C2DStatusText.PullImage)
  })

  it('should get running jobs', async () => {
    const job: DBComputeJob = {
      owner: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947261',
      jobId: null,
      jobIdHash: null,
      dateCreated: null,
      dateFinished: null,
      status: C2DStatusNumber.JobStarted,
      statusText: C2DStatusText.JobStarted,
      results: null,
      inputDID: ['did:op:1', 'did:op:2'],
      maxJobDuration: 1,

      // internal structure
      clusterHash: 'clusterHash',
      configlogURL: 'http://localhost:8000',
      publishlogURL: 'http://localhost:8000',
      algologURL: 'http://localhost:8000',
      outputsURL: 'http://localhost:8000',
      stopRequested: false,
      algorithm,
      assets: [dataset],
      environment: 'some environment',
      isRunning: false,
      isStarted: false,
      containerImage: 'another container image',
      resources: [],
      agreementId: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
      payment: {
        token: '0x123',
        lockTx: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
        claimTx: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
        cancelTx: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260fdc',
        chainId: 8996,
        cost: 0
      },
      isFree: false,
      algoStartTimestamp: '0',
      algoStopTimestamp: '0',
      algoDuration: 0,
      queueMaxWaitTime: 0
    }

    const jobId = await db.newJob(job)
    assert(jobId, 'Missing jobId identifier')
    const existing = await db.getRunningJobs()
    expect(existing.length === 2, 'No running jobs were found!')

    // Create a filter
    const withEnv = await db.getRunningJobs(null, 'some environment')
    expect(withEnv.length === 0, 'No running jobs were found for this environment')
    // delete it
    const deleted = await db.deleteJob(jobId)
    expect(deleted === true, `Job ${jobId} was not deleted!`)
  })

  it('should delete the job by jobId', async () => {
    const deleted = await db.deleteJob(jobId)
    expect(deleted === true, `Job ${jobId} was not deleted!`)
  })

  it('should convert array of strings to a string', () => {
    const inputDID = ['did:op:1', 'did:op:2', 'did:op:3']
    const expectedStr =
      'did:op:1' + STRING_SEPARATOR + 'did:op:2' + STRING_SEPARATOR + 'did:op:3'
    expect(convertArrayToString(inputDID)).to.equal(expectedStr)
  })

  it('should convert concatenated string to a string array', () => {
    const expectedArray = ['did:op:1', 'did:op:2', 'did:op:3']
    const str = 'did:op:1' + STRING_SEPARATOR + 'did:op:2' + STRING_SEPARATOR + 'did:op:3'
    expect(convertStringToArray(str)).to.deep.equal(expectedArray)
  })

  it('should convert DBComputeJob to ComputeJob and omit internal DB data', () => {
    const source: any = completeDBComputeJob
    const output: ComputeJob = omitDBComputeFieldsFromComputeJob(source as DBComputeJob)

    expect(Object.prototype.hasOwnProperty.call(output, 'clusterHash')).to.be.equal(false)
    expect(Object.prototype.hasOwnProperty.call(output, 'configlogURL')).to.be.equal(
      false
    )
    expect(Object.prototype.hasOwnProperty.call(output, 'publishlogURL')).to.be.equal(
      false
    )
    expect(Object.prototype.hasOwnProperty.call(output, 'algologURL')).to.be.equal(false)
    expect(Object.prototype.hasOwnProperty.call(output, 'outputsURL')).to.be.equal(false)
    expect(Object.prototype.hasOwnProperty.call(output, 'algorithm')).to.be.equal(false)
    expect(Object.prototype.hasOwnProperty.call(output, 'assets')).to.be.equal(false)
    expect(Object.prototype.hasOwnProperty.call(output, 'isRunning')).to.be.equal(false)
    expect(Object.prototype.hasOwnProperty.call(output, 'isStarted')).to.be.equal(false)
    expect(Object.prototype.hasOwnProperty.call(output, 'containerImage')).to.be.equal(
      false
    )
  })

  it('should check manifest platform against local platform env', () => {
    const arch = os.machine() // ex: arm
    const platform = os.platform() // ex: linux
    const env: RunningPlatform = {
      architecture: arch,
      os: platform
    }
    const result: boolean = checkManifestPlatform(dockerImageManifest.platform, env)
    // if all defined and a match its OK
    if (
      dockerImageManifest.platform.os === env.os &&
      dockerImageManifest.platform.architecture === env.architecture
    ) {
      expect(result).to.be.equal(true)
    } else {
      // oterwise its NOT
      expect(result).to.be.equal(false)
    }

    // all good anyway, nothing on the manifest
    expect(checkManifestPlatform(null, env)).to.be.equal(true)
  })

  describe('testing checkAndFillMissingResources', function () {
    let engine: TestC2DEngine

    before(function () {
      engine = new TestC2DEngine()
    })

    const baseResources = [
      { id: 'cpu', total: 8, min: 1, max: 8, inUse: 0 },
      { id: 'ram', total: 32, min: 1, max: 32, inUse: 0 },
      { id: 'disk', total: 500, min: 10, max: 500, inUse: 0 }
    ]

    it('satisfies constraints exactly → passes without modification', async function () {
      const resources = [
        ...baseResources.slice(0, 1).map((r) => ({
          ...r,
          constraints: [{ id: 'ram', min: 1, max: 4 }]
        })),
        ...baseResources.slice(1)
      ]
      const env = makeEnv(resources)
      // 4 cpu, 8 ram (= 4*2, in [4, 16]) → no change
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 4 },
        { id: 'ram', amount: 8 },
        { id: 'disk', amount: 50 }
      ]
      const result = await engine.checkAndFillMissingResources(req, env, false)
      const ramEntry = result.find((r) => r.id === 'ram')
      expect(ramEntry.amount).to.equal(8)
    })

    it('resource below constraint min → auto-bumped to required minimum', async function () {
      const resources = [
        { ...baseResources[0], constraints: [{ id: 'ram', min: 2, max: 8 }] },
        ...baseResources.slice(1)
      ]
      const env = makeEnv(resources)
      // 4 cpu, 4 ram → ram < 4*2=8 → should be bumped to 8
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 4 },
        { id: 'ram', amount: 4 },
        { id: 'disk', amount: 50 }
      ]
      const result = await engine.checkAndFillMissingResources(req, env, false)
      const ramEntry = result.find((r) => r.id === 'ram')
      expect(ramEntry.amount).to.equal(8)
    })

    it('resource above constraint max → throws meaningful error', async function () {
      const resources = [
        { ...baseResources[0], constraints: [{ id: 'ram', min: 1, max: 3 }] },
        ...baseResources.slice(1)
      ]
      const env = makeEnv(resources)
      // 4 cpu, 20 ram → ram > 4*3=12 → throws
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 4 },
        { id: 'ram', amount: 20 },
        { id: 'disk', amount: 50 }
      ]
      try {
        await engine.checkAndFillMissingResources(req, env, false)
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('Too much ram')
        expect(err.message).to.include('4 cpu')
        expect(err.message).to.include('Max allowed: 12')
      }
    })

    it('constraint involving GPU with 0 GPU requested → no constraint applied', async function () {
      const resources = [
        ...baseResources,
        {
          id: 'gpu',
          total: 4,
          min: 0,
          max: 4,
          inUse: 0,
          constraints: [{ id: 'ram', min: 8, max: 32 }]
        }
      ]
      const env = makeEnv(resources)
      // 0 gpu → gpu constraints should not be applied → ram stays at 4
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 2 },
        { id: 'ram', amount: 4 },
        { id: 'disk', amount: 50 },
        { id: 'gpu', amount: 0 }
      ]
      const result = await engine.checkAndFillMissingResources(req, env, false)
      const ramEntry = result.find((r) => r.id === 'ram')
      expect(ramEntry.amount).to.equal(4)
    })

    it('no constraints defined → existing behavior unchanged', async function () {
      const env = makeEnv(baseResources)
      // below min → bumped to min; above max → throws
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 0 },
        { id: 'ram', amount: 0 },
        { id: 'disk', amount: 0 }
      ]
      const result = await engine.checkAndFillMissingResources(req, env, false)
      const cpuEntry = result.find((r) => r.id === 'cpu')
      const diskEntry = result.find((r) => r.id === 'disk')
      expect(cpuEntry.amount).to.equal(1) // bumped to min
      expect(diskEntry.amount).to.equal(10) // bumped to min
    })
  })

  describe('testing checkIfResourcesAreAvailable', function () {
    let engine: TestC2DEngine

    before(function () {
      engine = new TestC2DEngine()
    })

    it('resources within env limits → passes', async function () {
      const env = makeEnv([
        { id: 'cpu', total: 8, min: 1, max: 8, inUse: 2 },
        { id: 'ram', total: 32, min: 1, max: 32, inUse: 4 },
        { id: 'disk', total: 500, min: 10, max: 500, inUse: 50 }
      ])
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 4 },
        { id: 'ram', amount: 8 },
        { id: 'disk', amount: 100 }
      ]
      // should not throw
      await engine.checkIfResourcesAreAvailable(req, env, false)
    })

    it('resources exceed env availability → throws', async function () {
      const env = makeEnv([
        { id: 'cpu', total: 4, min: 1, max: 4, inUse: 3 },
        { id: 'ram', total: 32, min: 1, max: 32, inUse: 0 },
        { id: 'disk', total: 500, min: 10, max: 500, inUse: 0 }
      ])
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 4 }, // only 1 available (4-3)
        { id: 'ram', amount: 8 },
        { id: 'disk', amount: 100 }
      ]
      try {
        await engine.checkIfResourcesAreAvailable(req, env, false)
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('Not enough available cpu')
      }
    })

    it('free resource limit exceeded → throws', async function () {
      const env = makeEnv(
        [
          { id: 'cpu', total: 8, min: 1, max: 8, inUse: 0 },
          { id: 'ram', total: 32, min: 1, max: 32, inUse: 0 },
          { id: 'disk', total: 500, min: 10, max: 500, inUse: 0 }
        ],
        {
          freeResources: [
            { id: 'cpu', total: 2, min: 1, max: 2, inUse: 2 }, // fully used
            { id: 'ram', total: 4, min: 1, max: 4, inUse: 0 },
            { id: 'disk', total: 20, min: 10, max: 20, inUse: 0 }
          ]
        }
      )
      const req: ComputeResourceRequest[] = [
        { id: 'cpu', amount: 1 },
        { id: 'ram', amount: 2 },
        { id: 'disk', amount: 10 }
      ]
      try {
        await engine.checkIfResourcesAreAvailable(req, env, true)
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('cpu')
      }
    })
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
