import { expect } from 'chai'
import sinon from 'sinon'
import { mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { C2DStatusNumber } from '../../@types/C2D/C2D.js'
import type { DBComputeJob } from '../../@types/C2D/C2D.js'

function ensureTestEnv() {
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
    getRunningJobs: sinon.stub().resolves([]),
    getJobsByStatus: sinon.stub().resolves([])
  } as any

  const clusterConfig = {
    type: 2,
    hash: 'test-hash',
    tempFolder: opts.tempFolder,
    connection: {
      imageRetentionDays: 1,
      imageCleanupInterval: 999999,
      paymentClaimInterval: 999999
    }
  } as any

  const engine = new C2DEngineDocker(clusterConfig, db, {} as any, {} as any, {} as any)
  ;(engine as any).cleanupJob = sinon.stub().resolves()
  ;(engine as any).updateImageUsage = sinon.stub().resolves()
  return { engine, db }
}

function makeJob(base: Partial<DBComputeJob> = {}): DBComputeJob {
  return {
    jobId: 'job-dup',
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
    algoStartTimestamp: '0',
    algoStopTimestamp: '0',
    buildStartTimestamp: '0',
    buildStopTimestamp: '0',
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
    containerImage: 'ocean-node-test:job-dup',
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

describe('C2DEngineDocker.sanitizeDockerfileEntryName', () => {
  let engine: any

  before(async () => {
    const tempFolder = path.join(os.tmpdir(), 'ocean-node-sanitizer-test')
    ;({ engine } = await makeEngine({ tempFolder }))
  })

  after(() => {
    sinon.restore()
  })

  const sanitize = (name: any) => engine.sanitizeDockerfileEntryName(name)

  it('passes through valid relative names', () => {
    expect(sanitize('a.txt')).to.equal('a.txt')
    expect(sanitize('sub/dir/file.sh')).to.equal('sub/dir/file.sh')
    expect(sanitize('Dockerfile.prod')).to.equal('Dockerfile.prod')
    expect(sanitize('dir/Dockerfile')).to.equal('dir/Dockerfile')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitize('  a.txt  ')).to.equal('a.txt')
  })

  it('strips a leading ./', () => {
    expect(sanitize('./a.txt')).to.equal('a.txt')
  })

  it('rejects empty / whitespace-only / non-string', () => {
    expect(() => sanitize('')).to.throw()
    expect(() => sanitize('   ')).to.throw()
    expect(() => sanitize(42 as any)).to.throw()
    expect(() => sanitize(undefined as any)).to.throw()
    expect(() => sanitize(null as any)).to.throw()
  })

  it('rejects absolute paths', () => {
    expect(() => sanitize('/etc/passwd')).to.throw()
  })

  it('rejects backslashes', () => {
    expect(() => sanitize('a\\b')).to.throw()
  })

  it('rejects path traversal', () => {
    expect(() => sanitize('..')).to.throw()
    expect(() => sanitize('../x')).to.throw()
    expect(() => sanitize('a/../../b')).to.throw()
  })

  it('rejects reserved build file names (case-insensitive, after ./)', () => {
    expect(() => sanitize('./Dockerfile')).to.throw()
    expect(() => sanitize('Dockerfile')).to.throw()
    expect(() => sanitize('dockerfile')).to.throw()
    expect(() => sanitize('.dockerignore')).to.throw()
  })

  it('rejects control characters (NUL)', () => {
    expect(() => sanitize('a\0b')).to.throw()
  })

  it('rejects directory entries (trailing slash)', () => {
    expect(() => sanitize('dir/')).to.throw()
  })

  it('rejects Windows drive paths', () => {
    expect(() => sanitize('C:foo')).to.throw()
  })

  it('rejects names that normalise to the build-context root (. / ./)', () => {
    expect(() => sanitize('.')).to.throw()
    expect(() => sanitize('./')).to.throw()
    expect(() => sanitize('  ./  ')).to.throw()
    expect(() => sanitize('foo/..')).to.throw()
  })
})

describe('C2DEngineDocker.resolveBuildTimeoutSeconds', () => {
  let engine: any
  const DEFAULT = 300

  before(async () => {
    const tempFolder = path.join(os.tmpdir(), 'ocean-node-buildtimeout-test')
    ;({ engine } = await makeEngine({ tempFolder }))
  })

  after(() => {
    sinon.restore()
  })

  const resolve = (configured: number | undefined, duration: number) =>
    engine.resolveBuildTimeoutSeconds(configured, duration)

  it('caps the configured/default value at a positive duration', () => {
    expect(resolve(600, 30)).to.equal(30)
    expect(resolve(100, 900)).to.equal(100)
    expect(resolve(undefined, 30)).to.equal(30)
    expect(resolve(undefined, 900)).to.equal(DEFAULT)
  })

  it('returns the configured/default base for non-finite durations', () => {
    expect(resolve(600, NaN)).to.equal(600)
    expect(resolve(600, Infinity)).to.equal(600)
    expect(resolve(undefined, NaN)).to.equal(DEFAULT)
  })

  it('returns the configured/default base for non-positive durations (0 / negative)', () => {
    expect(resolve(600, 0)).to.equal(600)
    expect(resolve(600, -10)).to.equal(600)
    expect(resolve(undefined, 0)).to.equal(DEFAULT)
    expect(resolve(undefined, -5)).to.equal(DEFAULT)
  })
})

describe('C2DEngineDocker.buildImage additionalDockerFiles duplicates', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('fails the build when two keys normalise to the same entry name', async () => {
    const tempFolder = path.join(os.tmpdir(), 'ocean-node-sanitizer-dup-test')
    const { engine, db } = await makeEngine({ tempFolder })

    const job = makeJob()
    mkdirSync(path.join((engine as any).getStoragePath(), job.jobId, 'data', 'logs'), {
      recursive: true
    })

    // docker.buildImage should never be reached — the duplicate throws first.
    const buildImageStub = sinon.stub().resolves(new Readable({ read() {} }))
    ;(engine as any).docker = {
      buildImage: buildImageStub,
      getImage: sinon.stub().returns({ inspect: sinon.stub().resolves({}) })
    }

    await (engine as any).buildImage(job, { 'a.txt': 'x', './a.txt': 'y' })

    expect(buildImageStub.called).to.equal(false)
    const lastUpdate = db.updateJob.lastCall.args[0] as DBComputeJob
    expect(lastUpdate.status).to.equal(C2DStatusNumber.BuildImageFailed)
  })
})

describe('C2DEngineDocker.withAbortSignal / bounded post-build scan', () => {
  let engine: any

  before(async () => {
    const tempFolder = path.join(os.tmpdir(), 'ocean-node-abort-test')
    ;({ engine } = await makeEngine({ tempFolder }))
  })

  afterEach(() => {
    sinon.restore()
  })

  it('rejects with ABORT_ERR when the signal aborts before the promise settles', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    let caught: any
    try {
      // a promise that never settles on its own — only the abort can end the wait
      await engine.withAbortSignal(controller.signal, new Promise(() => {}))
    } catch (e) {
      caught = e
    }
    expect(caught).to.not.equal(undefined)
    expect(caught.code).to.equal('ABORT_ERR')
  })

  it('resolves with the underlying value when the signal never aborts', async () => {
    const controller = new AbortController()
    const value = await engine.withAbortSignal(controller.signal, Promise.resolve(42))
    expect(value).to.equal(42)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let caught: any
    try {
      await engine.withAbortSignal(controller.signal, Promise.resolve('unused'))
    } catch (e) {
      caught = e
    }
    expect(caught?.code).to.equal('ABORT_ERR')
  })

  it('aborts a hung Trivy scan via the signal instead of hanging the job', async () => {
    engine.scanImages = true
    // checkImageVulnerability never resolves — without the signal guard this would hang forever
    sinon.stub(engine, 'checkImageVulnerability').returns(new Promise(() => {}))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    let caught: any
    try {
      await engine.scanAndRemoveIfVulnerable('img:latest', controller.signal)
    } catch (e) {
      caught = e
    }
    engine.scanImages = false
    expect(caught?.code).to.equal('ABORT_ERR')
  })
})
