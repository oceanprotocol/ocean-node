// import { expect } from 'chai'
import { C2DDatabase } from '../../components/database/C2DDatabase.js'
import { getConfiguration } from '../../utils/config.js'
import { typesenseSchemas } from '../../components/database/TypesenseSchemas.js'
import { ComputeAlgorithm, ComputeAsset, DBComputeJob } from '../../@types/C2D/C2D.js'
// import { computeAsset } from '../data/assets'
import { assert } from 'console'
import { expect } from 'chai'
import {
  convertArrayToString,
  convertStringToArray,
  STRING_SEPARATOR
} from '../../components/database/sqliteCompute.js'

describe('Compute Jobs', () => {
  let db: C2DDatabase = null
  let jobId: string = null
  before(async () => {
    const config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig, typesenseSchemas.c2dSchemas)
  })

  it('should create a new C2D Job', async () => {
    /**
     * export interface ComputeJob {
     owner: string
    did?: string
    jobId: string
    dateCreated: string
    dateFinished: string
    status: number
    statusText: string
    results: ComputeResult[]
    inputDID?: string[]
    algoDID?: string
    agreementId?: string
    expireTimestamp: number
    environment?: string

    // internal structure
    clusterHash: string
    configlogURL: string
    publishlogURL: string
    algologURL: string
    outputsURL: string
    stopRequested: boolean
    algorithm: ComputeAlgorithm
    assets: ComputeAsset[]
    isRunning: boolean
    isStarted: boolean
    containerImage: string
    }
 */
    const algorithm: ComputeAlgorithm = {
      documentId: 'did:op:12345',
      serviceId: '0x1828228'
    }
    const dataset: ComputeAsset = {
      documentId: 'did:op:12345',
      serviceId: '0x12345abc'
    }

    const job: DBComputeJob = {
      owner: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260',
      jobId: null,
      dateCreated: null,
      dateFinished: null,
      status: 1,
      statusText: 'Warming up',
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

  it('should delete the job by jobId', async () => {
    const deleted = await db.deleteJob(jobId)
    expect(deleted === true, 'Job was not deleted!')
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
