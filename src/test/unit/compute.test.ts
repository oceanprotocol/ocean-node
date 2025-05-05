import { C2DDatabase } from '../../components/database/C2DDatabase.js'
// import { existsEnvironmentVariable, getConfiguration } from '../../utils/config.js'
import { getConfiguration } from '../../utils/config.js'
import { typesenseSchemas } from '../../components/database/TypesenseSchemas.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  ComputeAlgorithm,
  ComputeAsset,
  // ComputeEnvironment,
  ComputeJob,
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
  tearDownEnvironment
} from '../utils/utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { completeDBComputeJob, dockerImageManifest } from '../data/assets.js'
import { omitDBComputeFieldsFromComputeJob } from '../../components/c2d/index.js'
import { checkManifestPlatform } from '../../components/c2d/compute_engine_docker.js'

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
        '[{"socketPath":"/var/run/docker.sock","resources":[{"id":"disk","total":1000000000}],"storageExpiry":604800,"maxJobDuration":3600,"fees":{"1":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":60,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1000000000},{"id":"disk","max":1000000000}]}}]'
      ]
    )
    envOverrides = await setupEnvironment(null, envOverrides)
    config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig, typesenseSchemas.c2dSchemas)
  })

  it('should create a new C2D Job', async () => {
    const job: DBComputeJob = {
      owner: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260',
      jobId: null,
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
        chainId: 8996
      },
      isFree: false,
      algoStartTimestamp: '0',
      algoStopTimestamp: '0'
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
        chainId: 8996
      },
      isFree: false,
      algoStartTimestamp: '0',
      algoStopTimestamp: '0'
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
    expect(Object.prototype.hasOwnProperty.call(output, 'stopRequested')).to.be.equal(
      false
    )
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

  it('testing checkAndFillMissingResources', async function () {
    // TO DO
  })
  it('testing checkIfResourcesAreAvailable', async function () {
    // TO DO
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
