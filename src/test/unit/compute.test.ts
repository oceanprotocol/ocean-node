// import { expect } from 'chai'
import { C2DDatabase } from '../../components/database/C2DDatabase.js'
import { existsEnvironmentVariable, getConfiguration } from '../../utils/config.js'
import { typesenseSchemas } from '../../components/database/TypesenseSchemas.js'
import {
  C2DStatusNumber,
  C2DStatusText,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeEnvironment,
  DBComputeJob
} from '../../@types/C2D/C2D.js'
// import { computeAsset } from '../data/assets'
import { assert, expect } from 'chai'
import {
  convertArrayToString,
  convertStringToArray,
  STRING_SEPARATOR
} from '../../components/database/sqliteCompute.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment
} from '../utils/utils.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'

describe('Compute Jobs Database', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: C2DDatabase = null
  let jobId: string = null

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
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.DOCKER_SOCKET_PATH],
      [
        '{ "8996":{ "rpc":"http://172.0.0.1:8545", "fallbackRPCs": ["http://172.0.0.3:8545","http://127.0.0.1:8545"], "chainId": 8996, "network": "development", "chunkSize": 100 }}',
        '/var/lib/docker'
      ]
    )
    envOverrides = await setupEnvironment(null, envOverrides)
    config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig, typesenseSchemas.c2dSchemas)
  })

  it('should have at least a free docker compute environment', () => {
    let size = 1
    if (existsEnvironmentVariable(ENVIRONMENT_VARIABLES.OPERATOR_SERVICE_URL, false)) {
      expect(config.c2dClusters.length).to.be.at.least(2)
      size = 2
    } else {
      expect(config.c2dClusters.length).to.be.at.least(1)
    }
    const dockerConfig = config.c2dClusters[size - 1].connection
    const freeEnv: ComputeEnvironment = dockerConfig.freeComputeOptions
    expect(freeEnv.desc).to.be.equal('Free')
    expect(freeEnv.free).to.be.equal(true)
    expect(freeEnv.id).to.be.equal(config.c2dClusters[size - 1].hash + '-free')
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
      expireTimestamp: 0,

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
      containerImage: 'some container image'
    }

    jobId = await db.newJob(job)
    assert(jobId, 'Missing jobId identifier')
  })

  it('should get job by jobId', async () => {
    const job = await db.getJob(jobId)
    assert(job, 'Job should not be null')
  })

  it('should update job', async () => {
    const job = await db.getJob(jobId)
    // will update some fields
    job.status = C2DStatusNumber.PullImage
    job.isRunning = true
    job.statusText = C2DStatusText.PullImage

    // update on DB
    const updates = await db.updateJob(job)
    expect(updates).to.be.equal(1) // updated 1 row
    const updatedJob = await db.getJob(jobId)
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
      expireTimestamp: 1,

      // internal structure
      clusterHash: 'clusterHash',
      configlogURL: 'http://localhost:8000',
      publishlogURL: 'http://localhost:8000',
      algologURL: 'http://localhost:8000',
      outputsURL: 'http://localhost:8000',
      stopRequested: false,
      algorithm,
      assets: [dataset],
      isRunning: false,
      isStarted: false,
      containerImage: 'another container image'
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
})
