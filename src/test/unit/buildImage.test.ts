import { expect } from 'chai'
import sinon from 'sinon'
import { mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { C2DStatusNumber } from '../../@types/C2D/C2D.js'
import type { DBComputeJob } from '../../@types/C2D/C2D.js'

function ensureTestEnv() {
  // Several runtime modules validate env on import; provide safe defaults for unit tests.
  if (!process.env.PRIVATE_KEY) {
    process.env.PRIVATE_KEY = `0x${'11'.repeat(32)}`
  }
}

async function makeEngine(opts: { tempFolder: string }) {
  ensureTestEnv()
  const { C2DEngineDocker } =
    await import('../../components/c2d/compute_engine_docker.js')
  const db = {
    updateJob: sinon.stub().resolves(),
    // buildImage() doesn't call getJobs*; keep minimal surface
    getRunningJobs: sinon.stub().resolves([]),
    getJobsByStatus: sinon.stub().resolves([])
  } as any

  const clusterConfig = {
    type: 2,
    hash: 'test-hash',
    tempFolder: opts.tempFolder,
    connection: {
      // keep constructor happy
      imageRetentionDays: 1,
      imageCleanupInterval: 999999,
      paymentClaimInterval: 999999
    }
  } as any

  const engine = new C2DEngineDocker(clusterConfig, db, {} as any, {} as any, {} as any)

  // prevent side-effects during unit tests
  ;(engine as any).cleanupJob = sinon.stub().resolves()
  ;(engine as any).updateImageUsage = sinon.stub().resolves()

  return { engine, db }
}

function makeJob(base: Partial<DBComputeJob> = {}): DBComputeJob {
  return {
    jobId: 'job-123',
    owner: '0x0',
    environment: 'env-1',
    dateCreated: String(Date.now() / 1000),
    dateFinished: null as any,
    clusterHash: 'test-hash',
    isFree: false,
    isRunning: true,
    isStarted: false,
    stopRequested: false,
    status: C2DStatusNumber.BuildImage,
    statusText: 'BuildImage',
    resources: [
      { id: 'cpu', amount: 1 },
      { id: 'ram', amount: 1 },
      { id: 'disk', amount: 1 }
    ],
    maxJobDuration: 60,
    queueMaxWaitTime: 0,
    // timestamps
    algoStartTimestamp: '0',
    algoStopTimestamp: '0',
    buildStartTimestamp: '0',
    buildStopTimestamp: '0',
    // algorithm/container
    algorithm: {
      did: 'did:op:algo',
      serviceIndex: 0,
      meta: {
        container: {
          image: 'dummy',
          tag: 'latest',
          entrypoint: 'node',
          checksum: '0x0',
          dockerfile: 'FROM alpine:3.18\nRUN echo hi\n'
        }
      }
    } as any,
    input: [] as any,
    output: '' as any,
    containerImage: 'ocean-node-test:job-123',
    algoDuration: 0,
    encryptedDockerRegistryAuth: undefined,
    payment: null as any,
    additionalViewers: [],
    logs: null as any,
    results: null as any,
    jobIdHash: '1',
    ...base
  } as DBComputeJob
}

describe('C2DEngineDocker.buildImage', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('marks build as failed if image is missing after build completes', async () => {
    const tempFolder = path.join(os.tmpdir(), 'ocean-node-buildimage-test')
    const { engine, db } = await makeEngine({ tempFolder })

    const job = makeJob()
    mkdirSync(path.join(tempFolder, job.jobId, 'data', 'logs'), { recursive: true })

    const buildStream = new Readable({ read() {} })
    ;(engine as any).docker = {
      buildImage: sinon.stub().resolves(buildStream),
      getImage: sinon.stub().returns({
        inspect: sinon.stub().rejects(new Error('no such image'))
      })
    }

    const p = (engine as any).buildImage(job, null)
    await new Promise<void>((resolve) => setImmediate(resolve))
    buildStream.emit('end')
    await p

    expect(db.updateJob.called).to.equal(true)
    const lastUpdate = db.updateJob.lastCall.args[0] as DBComputeJob
    expect(lastUpdate.status).to.equal(C2DStatusNumber.BuildImageFailed)
  })

  it('only logs success when image exists', async () => {
    const tempFolder = path.join(os.tmpdir(), 'ocean-node-buildimage-test-success')
    const { engine, db } = await makeEngine({ tempFolder })

    const job = makeJob({ containerImage: 'ocean-node-test:job-123-success' })
    mkdirSync(path.join(tempFolder, job.jobId, 'data', 'logs'), { recursive: true })

    const buildStream = new Readable({ read() {} })
    ;(engine as any).docker = {
      buildImage: sinon.stub().resolves(buildStream),
      getImage: sinon.stub().returns({
        inspect: sinon.stub().resolves({})
      })
    }

    const p = (engine as any).buildImage(job, null)
    await new Promise<void>((resolve) => setImmediate(resolve))
    buildStream.emit('end')
    await p

    const lastUpdate = db.updateJob.lastCall.args[0] as DBComputeJob
    expect(lastUpdate.status).to.equal(C2DStatusNumber.ConfiguringVolumes)
    expect(Number.parseFloat(lastUpdate.buildStopTimestamp)).to.be.greaterThan(0)
  })
})
