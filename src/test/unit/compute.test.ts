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
  ComputeResource,
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
import {
  checkManifestPlatform,
  C2DEngineDocker
} from '../../components/c2d/compute_engine_docker.js'
import { C2DDockerConfigSchema } from '../../utils/config/schemas.js'
import { ValidateParams } from '../../components/httpRoutes/validateCommands.js'
import { Readable } from 'stream'
import sinon from 'sinon'
import { getAlgoChecksums } from '../../components/core/compute/utils.js'
import { FindDdoHandler } from '../../components/core/handler/ddoHandler.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'

/* eslint-disable require-await */
class TestC2DEngine extends C2DEngine {
  constructor() {
    super(null, null, null, null, null)
  }

  setPhysicalLimits(limits: Map<string, number>) {
    this.physicalLimits = limits
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
        '[{"socketPath":"/var/run/docker.sock","environments":[{"storageExpiry":604800,"maxJobDuration":3600,"minJobDuration":60,"resources":[{"id":"cpu","total":4,"max":4,"min":1,"type":"cpu"},{"id":"ram","total":10,"max":10,"min":1,"type":"ram"},{"id":"disk","total":10,"max":10,"min":0,"type":"disk"}],"fees":{"1":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":60,"minJobDuration":10,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1},{"id":"disk","max":1}]}}]}]'
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
      { id: 'cpu', kind: 'fungible', total: 8, min: 1, max: 8, inUse: 0 },
      { id: 'ram', kind: 'fungible', total: 32, min: 1, max: 32, inUse: 0 },
      { id: 'disk', kind: 'fungible', total: 500, min: 10, max: 500, inUse: 0 }
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

    it('per-env constraint override: premium env uses 8 GB RAM, standard env uses 4 GB RAM', async function () {
      // Pool default: gpu0 requires ram min:4.
      // premium env overrides to ram min:8.
      // standard env inherits pool default (ram min:4).
      const gpuWithOverrideConstraint = {
        id: 'gpu0',
        kind: 'discrete',
        total: 1,
        min: 0,
        max: 1,
        inUse: 0,
        constraints: [{ id: 'ram', min: 8 }] // premium override
      }
      const gpuWithPoolConstraint = {
        id: 'gpu0',
        kind: 'discrete',
        total: 1,
        min: 0,
        max: 1,
        inUse: 0,
        constraints: [{ id: 'ram', min: 4 }] // pool default inherited by standard
      }
      const premiumEnv = makeEnv([
        { id: 'ram', kind: 'fungible', total: 32, min: 1, max: 32, inUse: 0 },
        gpuWithOverrideConstraint
      ])
      const standardEnv = makeEnv([
        { id: 'ram', kind: 'fungible', total: 32, min: 1, max: 32, inUse: 0 },
        gpuWithPoolConstraint
      ])

      const premiumReq: ComputeResourceRequest[] = [
        { id: 'ram', amount: 1 },
        { id: 'gpu0', amount: 1 }
      ]
      const standardReq: ComputeResourceRequest[] = [
        { id: 'ram', amount: 1 },
        { id: 'gpu0', amount: 1 }
      ]

      const premiumResult = await engine.checkAndFillMissingResources(
        premiumReq,
        premiumEnv,
        false
      )
      const standardResult = await engine.checkAndFillMissingResources(
        standardReq,
        standardEnv,
        false
      )

      expect(premiumResult.find((r) => r.id === 'ram').amount).to.equal(8)
      expect(standardResult.find((r) => r.id === 'ram').amount).to.equal(4)
    })

    it('ref.constraints: [] removes all constraints for env — GPU job admitted with only resource min', async function () {
      const gpuNoConstraints = {
        id: 'gpu0',
        kind: 'discrete',
        total: 1,
        min: 0,
        max: 1,
        inUse: 0,
        constraints: [] as any[] // no constraints for this env
      }
      const env = makeEnv([
        { id: 'ram', kind: 'fungible', total: 32, min: 1, max: 32, inUse: 0 },
        gpuNoConstraints
      ])
      const req: ComputeResourceRequest[] = [
        { id: 'ram', amount: 1 },
        { id: 'gpu0', amount: 1 }
      ]
      // No constraints → ram stays at 1 (not bumped to any min)
      const result = await engine.checkAndFillMissingResources(req, env, false)
      expect(result.find((r) => r.id === 'ram').amount).to.equal(1)
    })

    it('constraint-driven exhaustion: GPU becomes unrentable when RAM nearly depleted', async function () {
      // gpu0 requires min:4 GB RAM. Env has 10 GB RAM total, 9 GB in use → only 1 GB remaining.
      // Requesting gpu0 triggers checkAndFillMissingResources to bump RAM to 4 GB.
      // checkIfResourcesAreAvailable should then reject at Gate 1 (only 1 GB remaining).
      const resources = [
        { id: 'ram', kind: 'fungible', total: 10, min: 1, max: 10, inUse: 9 },
        {
          id: 'gpu0',
          kind: 'discrete',
          total: 1,
          min: 0,
          max: 1,
          inUse: 0,
          constraints: [{ id: 'ram', min: 4 }]
        }
      ]
      const env = makeEnv(resources)
      const req: ComputeResourceRequest[] = [
        { id: 'ram', amount: 1 },
        { id: 'gpu0', amount: 1 }
      ]

      // Step 1: auto-bump RAM from 1 to 4 (constraint min per gpu unit)
      const filled = await engine.checkAndFillMissingResources(req, env, false)
      expect(filled.find((r) => r.id === 'ram').amount).to.equal(4)

      // Step 2: 10 - 9 = 1 available < 4 requested → Gate 1 blocks
      try {
        await engine.checkIfResourcesAreAvailable(filled, env, false)
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('ram')
      }
    })
  })

  describe('testing checkIfResourcesAreAvailable', function () {
    let engine: TestC2DEngine

    before(function () {
      engine = new TestC2DEngine()
      engine.setPhysicalLimits(
        new Map([
          ['cpu', 10],
          ['ram', 32],
          ['disk', 100],
          ['gpu0', 1],
          ['nic0', 1]
        ])
      )
    })

    it('resources within env limits → passes', async function () {
      const env = makeEnv([
        { id: 'cpu', kind: 'fungible', total: 8, min: 1, max: 8, inUse: 2 },
        { id: 'ram', kind: 'fungible', total: 32, min: 1, max: 32, inUse: 4 },
        { id: 'disk', kind: 'fungible', total: 500, min: 10, max: 500, inUse: 50 }
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
        { id: 'cpu', kind: 'fungible', total: 4, min: 1, max: 4, inUse: 3 },
        { id: 'ram', kind: 'fungible', total: 32, min: 1, max: 32, inUse: 0 },
        { id: 'disk', kind: 'fungible', total: 500, min: 10, max: 500, inUse: 0 }
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
          { id: 'cpu', kind: 'fungible', total: 8, min: 1, max: 8, inUse: 0 },
          { id: 'ram', kind: 'fungible', total: 32, min: 1, max: 32, inUse: 0 },
          { id: 'disk', kind: 'fungible', total: 500, min: 10, max: 500, inUse: 0 }
        ],
        {
          freeResources: [
            { id: 'cpu', kind: 'fungible', total: 2, min: 1, max: 2, inUse: 2 }, // fully used
            { id: 'ram', kind: 'fungible', total: 4, min: 1, max: 4, inUse: 0 },
            { id: 'disk', kind: 'fungible', total: 20, min: 10, max: 20, inUse: 0 }
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

    it('Gate 1 (per-env ceiling, fungible) blocks when env capacity exhausted', async function () {
      const env = makeEnv([
        { id: 'cpu', kind: 'fungible', total: 6, min: 1, max: 6, inUse: 6 }
      ])
      const req: ComputeResourceRequest[] = [{ id: 'cpu', amount: 1 }]
      try {
        await engine.checkIfResourcesAreAvailable(req, env, false)
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('Not enough available cpu')
        expect(err.message).to.include('environment')
      }
    })

    it('Gate 2 (engine-wide pool, fungible) blocks when global capacity exhausted across two envs', async function () {
      // Pool: 10 physical CPUs. env1 uses 6, env2 uses 4 → 10 total in-use.
      const env1 = makeEnv([
        { id: 'cpu', kind: 'fungible', total: 6, min: 1, max: 6, inUse: 6 }
      ])
      env1.id = 'env1'
      const env2 = makeEnv([
        { id: 'cpu', kind: 'fungible', total: 6, min: 1, max: 6, inUse: 4 }
      ])
      env2.id = 'env2'
      // env2 Gate 1: 6 - 4 = 2 >= 1 → passes. Gate 2: total 12 capped to 10, used 10, remaining 0 < 1 → blocks.
      const req: ComputeResourceRequest[] = [{ id: 'cpu', amount: 1 }]
      try {
        await engine.checkIfResourcesAreAvailable(req, env2, false, [env1, env2])
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('globally')
      }
    })

    it('Gate 2 passes when global capacity is available (env1 partially used)', async function () {
      const env1 = makeEnv([
        { id: 'cpu', kind: 'fungible', total: 6, min: 1, max: 6, inUse: 3 }
      ])
      env1.id = 'env1'
      const env2 = makeEnv([
        { id: 'cpu', kind: 'fungible', total: 6, min: 1, max: 6, inUse: 2 }
      ])
      env2.id = 'env2'
      // Gate 2: total 12 capped to 10, used 5, remaining 5 >= 1 → passes
      const req: ComputeResourceRequest[] = [{ id: 'cpu', amount: 1 }]
      await engine.checkIfResourcesAreAvailable(req, env2, false, [env1, env2])
      // no throw = pass
    })

    it('discrete exclusive (GPU) globally tracked — second job blocked when total:1 in use', async function () {
      // gpu0 is a discrete exclusive resource (total:1). env1 has it in-use.
      const env1 = makeEnv([
        {
          id: 'gpu0',
          kind: 'discrete',
          shareable: false,
          total: 1,
          min: 0,
          max: 1,
          inUse: 1
        }
      ])
      env1.id = 'env1'
      const env2 = makeEnv([
        {
          id: 'gpu0',
          kind: 'discrete',
          shareable: false,
          total: 1,
          min: 0,
          max: 1,
          inUse: 0
        }
      ])
      env2.id = 'env2'
      // Gate 2: globalTotal = 2 capped to physicalLimits['gpu0']=1, globalUsed=1, remaining=0 < 1 → blocks
      const req: ComputeResourceRequest[] = [{ id: 'gpu0', amount: 1 }]
      try {
        await engine.checkIfResourcesAreAvailable(req, env2, false, [env1, env2])
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('gpu0')
        expect(err.message).to.include('globally')
      }
    })

    it('discrete shareable (NIC) never blocks allocation — both jobs admitted', async function () {
      // nic0 is shareable discrete. env1 already has it in-use.
      const env1 = makeEnv([
        {
          id: 'nic0',
          kind: 'discrete',
          shareable: true,
          total: 1,
          min: 0,
          max: 1,
          inUse: 1
        }
      ])
      env1.id = 'env1'
      const env2 = makeEnv([
        {
          id: 'nic0',
          kind: 'discrete',
          shareable: true,
          total: 1,
          min: 0,
          max: 1,
          inUse: 0
        }
      ])
      env2.id = 'env2'
      // isShareableDiscrete = true → Gate 2 skipped → no throw
      const req: ComputeResourceRequest[] = [{ id: 'nic0', amount: 1 }]
      await engine.checkIfResourcesAreAvailable(req, env2, false, [env1, env2])
      // no throw = pass
    })

    it('non-GPU discrete resource is globally tracked (kind drives tracking, not type)', async function () {
      // An FPGA with kind:'discrete' but type:'fpga' must be globally tracked just like a GPU.
      const env1 = makeEnv([
        {
          id: 'fpga0',
          kind: 'discrete',
          type: 'fpga',
          total: 1,
          min: 0,
          max: 1,
          inUse: 1
        }
      ])
      env1.id = 'env1'
      const env2 = makeEnv([
        {
          id: 'fpga0',
          kind: 'discrete',
          type: 'fpga',
          total: 1,
          min: 0,
          max: 1,
          inUse: 0
        }
      ])
      env2.id = 'env2'
      ;(engine as any).physicalLimits.set('fpga0', 1)
      const req: ComputeResourceRequest[] = [{ id: 'fpga0', amount: 1 }]
      try {
        await engine.checkIfResourcesAreAvailable(req, env2, false, [env1, env2])
        assert.fail('Expected error was not thrown')
      } catch (err: any) {
        expect(err.message).to.include('fpga0')
        expect(err.message).to.include('globally')
      }
    })

    it('discrete GPU — double-counting across envs does not block when capacity remains', async function () {
      // Setup: 2 physical GPUs (physicalLimits gpu0=2), two environments each advertising
      // total:2. A single job consumes 1 GPU on env1. getUsedResources aggregates discrete
      // usage globally, so both env1 and env2 receive inUse:1. Without the max-vs-sum fix,
      // checkGlobalResourceAvailability would compute globalUsed = 1+1 = 2, exhausting
      // the physical pool and incorrectly blocking the next allocation.
      engine.setPhysicalLimits(
        new Map([
          ['cpu', 10],
          ['ram', 32],
          ['disk', 100],
          ['gpu0', 2],
          ['nic0', 1]
        ])
      )
      const env1 = makeEnv([
        {
          id: 'gpu0',
          kind: 'discrete',
          shareable: false,
          total: 2,
          min: 0,
          max: 2,
          inUse: 1
        }
      ])
      env1.id = 'env1'
      // env2 carries the same global inUse value because getUsedResources tracks discrete globally
      const env2 = makeEnv([
        {
          id: 'gpu0',
          kind: 'discrete',
          shareable: false,
          total: 2,
          min: 0,
          max: 2,
          inUse: 1
        }
      ])
      env2.id = 'env2'
      // 1 GPU in use, 1 remaining — this request must succeed, not be double-blocked
      const req: ComputeResourceRequest[] = [{ id: 'gpu0', amount: 1 }]
      await engine.checkIfResourcesAreAvailable(req, env2, false, [env1, env2])
      // no throw = pass (double-counting would have thrown "Not enough gpu0 globally")
    })
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})

describe('Schema validation (C2DDockerConfigSchema)', () => {
  const validBase = {
    socketPath: '/var/run/docker.sock',
    environments: [
      {
        storageExpiry: 604800,
        maxJobDuration: 3600,
        minJobDuration: 60,
        fees: { '1': [{ feeToken: '0x123', prices: [{ id: 'cpu', price: 1 }] }] }
      }
    ]
  }

  it('old format (env resources with init) is rejected — clean break enforced', function () {
    const config = [
      {
        ...validBase,
        environments: [
          {
            ...validBase.environments[0],
            resources: [
              {
                id: 'gpu0',
                total: 1,
                init: {
                  deviceRequests: {
                    Driver: 'nvidia',
                    DeviceIDs: ['uuid-a'],
                    Capabilities: [['gpu']]
                  }
                }
              }
            ]
          }
        ]
      }
    ]
    const result = C2DDockerConfigSchema.safeParse(config)
    expect(result.success).to.equal(false)
    const msgs = result.error?.issues.map((i) => i.message).join(' ')
    expect(msgs).to.include('migration guide')
  })

  it('env ref pointing to unknown pool id is rejected', function () {
    const config = [
      {
        ...validBase,
        environments: [
          {
            ...validBase.environments[0],
            resources: [{ id: 'unknown-gpu' }]
          }
        ]
      }
    ]
    const result = C2DDockerConfigSchema.safeParse(config)
    expect(result.success).to.equal(false)
    const msgs = result.error?.issues.map((i) => i.message).join(' ')
    expect(msgs).to.include('not found in connection-level resources')
  })

  it('shareable:true on type:gpu resource is rejected', function () {
    const config = [
      {
        ...validBase,
        resources: [
          {
            id: 'gpu0',
            type: 'gpu',
            kind: 'discrete',
            total: 1,
            shareable: true,
            init: {
              deviceRequests: {
                Driver: 'nvidia',
                DeviceIDs: ['uuid-a'],
                Capabilities: [['gpu']]
              }
            }
          }
        ],
        environments: [
          {
            ...validBase.environments[0],
            resources: [{ id: 'gpu0' }]
          }
        ]
      }
    ]
    const result = C2DDockerConfigSchema.safeParse(config)
    expect(result.success).to.equal(false)
    const msgs = result.error?.issues.map((i) => i.message).join(' ')
    expect(msgs).to.include('shareable:true is not allowed')
  })

  it('valid two-level config with GPU pool and env refs parses successfully', function () {
    const config = [
      {
        socketPath: '/var/run/docker.sock',
        resources: [
          {
            id: 'gpu0',
            kind: 'discrete',
            type: 'gpu',
            total: 1,
            init: {
              deviceRequests: {
                Driver: 'nvidia',
                DeviceIDs: ['uuid-a'],
                Capabilities: [['gpu']]
              }
            }
          }
        ],
        environments: [
          {
            storageExpiry: 604800,
            maxJobDuration: 3600,
            minJobDuration: 60,
            resources: [{ id: 'cpu' }, { id: 'ram' }, { id: 'disk' }, { id: 'gpu0' }],
            fees: { '1': [{ feeToken: '0x123', prices: [{ id: 'gpu0', price: 5 }] }] }
          }
        ]
      }
    ]
    const result = C2DDockerConfigSchema.safeParse(config)
    expect(result.success).to.equal(true)
  })
})

describe('resolveResourceKind / resolveConnectionResourcePool / resolveEnvironmentResources', () => {
  let engine: any

  beforeEach(function () {
    // Use Object.create to bypass the Docker-specific constructor while retaining the prototype chain.
    engine = Object.create(C2DEngineDocker.prototype)
    engine.physicalLimits = new Map<string, number>()
  })

  describe('resolveResourceKind()', function () {
    it('explicit kind:"discrete" wins over init presence', function () {
      const res: Partial<ComputeResource> = {
        id: 'cpu',
        kind: 'discrete',
        init: undefined
      }
      expect(engine.resolveResourceKind(res)).to.equal('discrete')
    })

    it('explicit kind:"fungible" wins even when init is present', function () {
      const res: Partial<ComputeResource> = {
        id: 'cpu',
        kind: 'fungible',
        init: {
          deviceRequests: { Driver: 'nvidia', DeviceIDs: ['x'], Capabilities: [['gpu']] }
        }
      }
      expect(engine.resolveResourceKind(res)).to.equal('fungible')
    })

    it('no kind + init present → inferred as discrete', function () {
      const res: Partial<ComputeResource> = {
        id: 'gpu0',
        init: {
          deviceRequests: { Driver: 'nvidia', DeviceIDs: ['x'], Capabilities: [['gpu']] }
        }
      }
      expect(engine.resolveResourceKind(res)).to.equal('discrete')
    })

    it('no kind, no init → inferred as fungible', function () {
      const res: Partial<ComputeResource> = { id: 'cpu' }
      expect(engine.resolveResourceKind(res)).to.equal('fungible')
    })
  })

  describe('resolveConnectionResourcePool()', function () {
    it('auto-detects cpu and ram from sysinfo; disk from physicalLimits', function () {
      engine.physicalLimits.set('disk', 200)
      const sysinfo = { NCPU: 8, MemTotal: 32 * 1024 * 1024 * 1024 } // 32 GB
      const pool = engine.resolveConnectionResourcePool(sysinfo, [])
      expect(pool.get('cpu').total).to.equal(8)
      expect(pool.get('ram').total).to.equal(32)
      expect(pool.get('disk').total).to.equal(200)
      expect(pool.get('cpu').kind).to.equal('fungible')
      expect(pool.get('ram').kind).to.equal('fungible')
    })

    it('configured total caps cpu at physical limit', function () {
      engine.physicalLimits.set('cpu', 8)
      engine.physicalLimits.set('disk', 100)
      const sysinfo = { NCPU: 8, MemTotal: 32 * 1024 * 1024 * 1024 }
      // Config requests 6 cores (cap below physical) → should use 6.
      const pool = engine.resolveConnectionResourcePool(sysinfo, [
        { id: 'cpu', total: 6, min: 1 }
      ])
      expect(pool.get('cpu').total).to.equal(6)
    })

    it('configured total exceeding physical is capped at physical', function () {
      engine.physicalLimits.set('cpu', 8)
      engine.physicalLimits.set('disk', 100)
      const sysinfo = { NCPU: 8, MemTotal: 16 * 1024 * 1024 * 1024 }
      // Config requests 20 cores on an 8-core host → capped to 8.
      const pool = engine.resolveConnectionResourcePool(sysinfo, [
        { id: 'cpu', total: 20 }
      ])
      expect(pool.get('cpu').total).to.equal(8)
    })

    it('custom GPU resource is added to pool and registered in physicalLimits', function () {
      engine.physicalLimits.set('disk', 100)
      const sysinfo = { NCPU: 4, MemTotal: 8 * 1024 * 1024 * 1024 }
      const gpu = {
        id: 'gpu0',
        type: 'gpu',
        total: 1,
        init: {
          deviceRequests: {
            Driver: 'nvidia',
            DeviceIDs: ['uuid-a'],
            Capabilities: [['gpu']]
          }
        }
      }
      const pool = engine.resolveConnectionResourcePool(sysinfo, [gpu])
      expect(pool.has('gpu0')).to.equal(true)
      expect(pool.get('gpu0').kind).to.equal('discrete') // inferred from init
      expect(pool.get('gpu0').total).to.equal(1)
      expect(engine.physicalLimits.get('gpu0')).to.equal(1)
    })
  })

  describe('resolveEnvironmentResources()', function () {
    let pool: Map<string, ComputeResource>

    beforeEach(function () {
      pool = new Map([
        ['cpu', { id: 'cpu', kind: 'fungible', type: 'cpu', total: 10, min: 1, max: 10 }],
        ['ram', { id: 'ram', kind: 'fungible', type: 'ram', total: 32, min: 1, max: 32 }],
        [
          'disk',
          { id: 'disk', kind: 'fungible', type: 'disk', total: 100, min: 1, max: 100 }
        ],
        [
          'gpu0',
          {
            id: 'gpu0',
            kind: 'discrete',
            type: 'gpu',
            total: 1,
            min: 0,
            max: 1,
            constraints: [{ id: 'ram', min: 4 }],
            init: {
              deviceRequests: {
                Driver: 'nvidia',
                DeviceIDs: ['uuid-a'],
                Capabilities: [['gpu']]
              }
            }
          }
        ]
      ])
    })

    it('ref.total becomes env aggregate ceiling for fungible (capped at pool.total)', function () {
      const envDef = { resources: [{ id: 'cpu', total: 6 }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      expect(result[0].total).to.equal(6)
    })

    it('ref.total exceeding pool.total is capped at pool.total', function () {
      const envDef = { resources: [{ id: 'cpu', total: 999 }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      expect(result[0].total).to.equal(10) // pool.total = 10
    })

    it('omitting ref.total inherits pool total for fungible', function () {
      const envDef = { resources: [{ id: 'cpu' }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      expect(result[0].total).to.equal(10)
    })

    it('ref.max is capped to resolved.total', function () {
      const envDef = { resources: [{ id: 'cpu', total: 6, max: 99 }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      expect(result[0].max).to.equal(6) // capped to total
    })

    it('ref.min overrides pool min', function () {
      const envDef = { resources: [{ id: 'cpu', min: 2 }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      expect(result[0].min).to.equal(2)
    })

    it('ref.constraints replaces pool constraints entirely', function () {
      const envDef = {
        resources: [
          {
            id: 'gpu0',
            constraints: [
              { id: 'ram', min: 8 },
              { id: 'cpu', min: 4 }
            ]
          }
        ]
      }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      const gpuRes = result.find((r: ComputeResource) => r.id === 'gpu0')
      expect(gpuRes.constraints).to.have.length(2)
      expect(gpuRes.constraints[0]).to.deep.equal({ id: 'ram', min: 8 })
    })

    it('ref.constraints: [] removes all constraints for this env', function () {
      const envDef = { resources: [{ id: 'gpu0', constraints: [] as any[] }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      const gpuRes = result.find((r: ComputeResource) => r.id === 'gpu0')
      expect(gpuRes.constraints).to.deep.equal([])
    })

    it('omitting ref.constraints inherits pool constraints (deep-cloned)', function () {
      const envDef = { resources: [{ id: 'gpu0' }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      const gpuRes = result.find((r: ComputeResource) => r.id === 'gpu0')
      expect(gpuRes.constraints).to.deep.equal([{ id: 'ram', min: 4 }])
      // Mutating the resolved constraints must not affect the pool
      gpuRes.constraints[0].min = 99
      expect(pool.get('gpu0').constraints[0].min).to.equal(4)
    })

    it('init is deep-cloned: mutating resolved.init does not corrupt pool', function () {
      const envDef = { resources: [{ id: 'gpu0' }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      const gpuRes = result.find((r: ComputeResource) => r.id === 'gpu0')
      gpuRes.init.deviceRequests.DeviceIDs[0] = 'mutated'
      expect(pool.get('gpu0').init.deviceRequests.DeviceIDs[0]).to.equal('uuid-a')
    })

    it('unknown ref.id is skipped silently', function () {
      const envDef = { resources: [{ id: 'nonexistent' }] }
      const result = engine.resolveEnvironmentResources(envDef, pool)
      expect(result).to.have.length(0)
    })
  })
})

describe('getAlgoChecksums', () => {
  let findDdoStub: sinon.SinonStub
  let loggerErrorSpy: sinon.SinonSpy

  beforeEach(() => {
    findDdoStub = sinon.stub(FindDdoHandler.prototype, 'findAndFormatDdo')
    loggerErrorSpy = sinon.spy(CORE_LOGGER, 'error')
  })

  afterEach(() => {
    findDdoStub.restore()
    loggerErrorSpy.restore()
  })

  it('returns empty checksums without a DDO lookup for raw-code algorithms (no documentId)', async () => {
    const checksums = await getAlgoChecksums(
      undefined,
      undefined,
      null as any,
      null as any
    )

    expect(checksums).to.deep.equal({ files: '', container: '', serviceId: undefined })
    // no DDO lookup must be attempted when there is no algorithm documentId
    expect(findDdoStub.called).to.equal(false)
    // and therefore no "Algorithm with id: undefined not found!" error is logged
    expect(loggerErrorSpy.called).to.equal(false)
  })
})
