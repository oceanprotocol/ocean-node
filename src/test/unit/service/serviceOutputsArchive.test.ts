import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import * as tarStream from 'tar-stream'
import yauzl from 'yauzl'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import {
  ServiceResultError,
  emptyOutputsDirTar,
  tarToZip,
  zipEntryName
} from '../../../components/c2d/serviceOutputsZip.js'
import { ServiceStatusNumber, ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'

const OWNER = '0x0000000000000000000000000000000000000001'
const SERVICE_ID = 'svc-outputs-1'
const CLUSTER_HASH = 'hash-outputs'

type TarEntry = {
  name: string
  type?: string
  mode?: number
  content?: string
  linkname?: string
}

// A tar shaped like `container.getArchive({ path: '/data/outputs' })`: rooted at "outputs/".
function makeTar(entries: TarEntry[]): Promise<Buffer> {
  const pack = tarStream.pack()
  for (const e of entries) {
    const header: any = { name: e.name, type: e.type ?? 'file', mode: e.mode ?? 0o644 }
    if (e.linkname) header.linkname = e.linkname
    if (header.type === 'file') pack.entry(header, e.content ?? '')
    else pack.entry(header)
  }
  pack.finalize()
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    pack.on('data', (c: Buffer) => chunks.push(c))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)
  })
}

const OUTPUTS_TAR: TarEntry[] = [
  { name: 'outputs', type: 'directory', mode: 0o777 },
  { name: 'outputs/result.txt', content: 'hello', mode: 0o640 },
  { name: 'outputs/images', type: 'directory', mode: 0o755 },
  { name: 'outputs/images/a.png', content: 'png-bytes' },
  { name: 'outputs/escape', type: 'symlink', linkname: '/etc/passwd' },
  { name: 'outputs/hard', type: 'link', linkname: 'outputs/result.txt' },
  { name: 'outputs/../../evil.sh', content: 'rm -rf /' }
]

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c)
  return Buffer.concat(chunks)
}

type ZipEntry = { name: string; mode: number; content?: string }

function readZip(buf: Buffer): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err)
      const entries: ZipEntry[] = []
      zip.on('error', reject)
      zip.on('end', () => resolve(entries))
      zip.on('entry', (entry) => {
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff
        if (entry.fileName.endsWith('/')) {
          entries.push({ name: entry.fileName, mode })
          return zip.readEntry()
        }
        zip.openReadStream(entry, async (e, rs) => {
          if (e) return reject(e)
          entries.push({
            name: entry.fileName,
            mode,
            content: (await streamToBuffer(rs)).toString()
          })
          zip.readEntry()
        })
      })
      zip.readEntry()
    })
  })
}

function makeJob(overrides: Partial<ServiceJob> = {}): ServiceJob {
  return {
    serviceId: SERVICE_ID,
    clusterHash: CLUSTER_HASH,
    environment: 'env-1',
    owner: OWNER,
    image: 'img',
    tag: 'latest',
    containerImage: 'img:latest',
    containerId: 'c1',
    networkId: '',
    status: ServiceStatusNumber.Running,
    statusText: 'Running',
    dateCreated: new Date(0).toISOString(),
    expiresAt: Date.now() + 3600_000,
    duration: 3600,
    exposedPorts: [],
    endpoints: [],
    resources: [],
    payment: {
      chainId: 8996,
      token: '0xtoken',
      lockTx: '0xl',
      claimTx: '0xc',
      cancelTx: '',
      cost: 5
    },
    ...overrides
  }
}

function dockerError(statusCode: number) {
  const e: any = new Error(`docker ${statusCode}`)
  e.statusCode = statusCode
  return e
}

// Same pattern as serviceRestartRace.test.ts: skip the Docker constructor, keep the prototype.
function makeEngine(tempFolder: string): any {
  const engine: any = Object.create(C2DEngineDocker.prototype)
  engine.docker = {
    getNetwork: sinon.stub().returns({
      inspect: sinon.stub().rejects(dockerError(404)),
      remove: sinon.stub().resolves(undefined)
    }),
    getContainer: sinon.stub()
  }
  engine.db = {
    getServiceJob: sinon.stub().resolves([]),
    updateServiceJob: sinon.stub().resolves(1),
    getExpiredServiceJobsBefore: sinon.stub().resolves([]),
    acquireServiceLock: sinon.stub().resolves(true),
    releaseServiceLock: sinon.stub().resolves(undefined),
    refreshServiceLocks: sinon.stub().resolves(undefined),
    isServiceLocked: sinon.stub().resolves(false)
  }
  engine.serviceLockHolderId = 'test-holder'
  engine.cpuAllocations = new Map()
  engine.serviceOpsInFlight = new Set()
  engine.serviceOpPromises = new Set()
  engine.clusterConfig = {
    hash: CLUSTER_HASH,
    tempFolder: tempFolder + '/',
    connection: { resources: [], serviceOnDemand: {} }
  }
  engine.stopped = false
  return engine
}

// getArchive is called afresh for every archive, so every call gets a new tar stream.
function outputsContainer(id: string, entries: TarEntry[] = OUTPUTS_TAR) {
  return {
    id,
    stop: sinon.stub().resolves(undefined),
    remove: sinon.stub().resolves(undefined),
    getArchive: sinon.stub().callsFake(async () => Readable.from(await makeTar(entries)))
  }
}

describe('service /data/outputs archives', () => {
  let tempFolder: string
  beforeEach(() => {
    tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-svc-outputs-'))
  })
  afterEach(() => {
    sinon.restore()
    fs.rmSync(tempFolder, { recursive: true, force: true })
  })

  describe('zipEntryName', () => {
    it('strips the outputs/ root Docker adds', () => {
      expect(zipEntryName('outputs')).to.equal('')
      expect(zipEntryName('outputs/')).to.equal('')
      expect(zipEntryName('outputs/a/b.txt')).to.equal('a/b.txt')
    })
    it('rejects names that could escape the extraction folder', () => {
      expect(zipEntryName('/etc/passwd')).to.equal(null)
      expect(zipEntryName('C:/x')).to.equal(null)
      expect(zipEntryName('outputs/../../x')).to.equal(null)
      expect(zipEntryName('outputs\\..\\x')).to.equal(null)
      expect(zipEntryName('outputs/./x')).to.equal(null)
    })
  })

  describe('tarToZip', () => {
    it('keeps files and folders with their permissions, skips links and unsafe names', async () => {
      let stats: any
      const zip = await streamToBuffer(
        tarToZip(Readable.from(await makeTar(OUTPUTS_TAR)), (s) => (stats = s))
      )
      const entries = await readZip(zip)
      expect(entries.map((e) => e.name)).to.have.members([
        'result.txt',
        'images/',
        'images/a.png'
      ])
      const result = entries.find((e) => e.name === 'result.txt')
      expect(result.content).to.equal('hello')
      expect(result.mode).to.equal(0o100640)
      expect(entries.find((e) => e.name === 'images/').mode).to.equal(0o040755)
      expect(entries.find((e) => e.name === 'images/a.png').content).to.equal('png-bytes')
      expect(stats).to.deep.equal({ files: 2, directories: 1, skipped: 3 })
    })

    it('produces a valid empty zip for an empty folder', async () => {
      const zip = await streamToBuffer(
        tarToZip(Readable.from(await makeTar([{ name: 'outputs', type: 'directory' }])))
      )
      expect(await readZip(zip)).to.deep.equal([])
    })

    it('fails the zip stream when the tar is corrupt', async () => {
      let error: Error
      try {
        await streamToBuffer(tarToZip(Readable.from(Buffer.alloc(1024, 7))))
      } catch (e) {
        error = e
      }
      expect(error).to.be.instanceOf(Error)
    })
  })

  it('emptyOutputsDirTar never re-creates an existing /data', async () => {
    const names = async (root: '/' | '/data') => {
      const extract = tarStream.extract()
      const found: string[] = []
      extract.on('entry', (h, s, next) => {
        found.push(`${h.name}:${(h.mode & 0o777).toString(8)}`)
        s.on('end', next)
        s.resume()
      })
      const done = new Promise((resolve) => extract.on('finish', resolve))
      extract.end(await emptyOutputsDirTar(root))
      await done
      return found
    }
    expect(await names('/')).to.deep.equal(['data:755', 'data/outputs:777'])
    expect(await names('/data')).to.deep.equal(['outputs:777'])
  })

  describe('archiving on teardown', () => {
    const folder = () => path.join(tempFolder, CLUSTER_HASH, 'services', SERVICE_ID)

    it('stop archives /data/outputs after stopping and before removing the container', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      engine.db.getServiceJob.resolves([job])
      const c = outputsContainer('c1')
      engine.docker.getContainer.returns(c)

      const stopped = await engine.stopService(SERVICE_ID, OWNER)

      expect(stopped.status).to.equal(ServiceStatusNumber.Stopped)
      sinon.assert.callOrder(c.stop, c.getArchive, c.remove)
      expect(stopped.outputArchives).to.have.lengthOf(1)
      const [archive] = stopped.outputArchives
      expect(archive).to.include({
        index: 0,
        filename: 'outputs-0.zip',
        reason: 'stop',
        containerId: 'c1'
      })
      const file = path.join(folder(), 'outputs-0.zip')
      expect(archive.filesize).to.equal(fs.statSync(file).size)
      expect(fs.existsSync(file + '.partial')).to.equal(false)
      const entries = await readZip(fs.readFileSync(file))
      expect(entries.find((e) => e.name === 'result.txt').content).to.equal('hello')
    })

    it('the expiry teardown records reason "expiry"', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob({ expiresAt: Date.now() - 1000 })
      engine.db.getServiceJob.resolves([job])
      engine.docker.getContainer.returns(outputsContainer('c1'))
      const stopped = await engine.stopService(SERVICE_ID, OWNER, true)
      expect(stopped.outputArchives[0].reason).to.equal('expiry')
    })

    it('numbers archives per container and never archives the same container twice', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      await engine.archiveServiceOutputs(job, outputsContainer('c1'), 'restart')
      await engine.archiveServiceOutputs(job, outputsContainer('c1'), 'stop') // retried teardown
      await engine.archiveServiceOutputs(job, outputsContainer('c2'), 'stop')
      expect(
        job.outputArchives.map((a) => [a.index, a.containerId, a.reason])
      ).to.deep.equal([
        [0, 'c1', 'restart'],
        [1, 'c2', 'stop']
      ])
      expect(fs.readdirSync(folder()).sort()).to.deep.equal([
        'outputs-0.zip',
        'outputs-1.zip'
      ])
    })

    it('skips a service with an output bucket', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob({ outputBucketId: 'bucket-1' })
      const c = outputsContainer('c1')
      await engine.archiveServiceOutputs(job, c, 'stop')
      sinon.assert.notCalled(c.getArchive)
      expect(job.outputArchives).to.equal(undefined)
    })

    it('treats a missing /data/outputs as nothing to archive', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      const c = outputsContainer('c1')
      c.getArchive = sinon.stub().rejects(dockerError(404))
      await engine.archiveServiceOutputs(job, c, 'stop')
      expect(job.outputArchives).to.equal(undefined)
      expect(job.outputArchiveError).to.equal(undefined)
    })

    it('records a failure without throwing and leaves no partial file', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      const c = outputsContainer('c1')
      c.getArchive = sinon.stub().resolves(Readable.from(Buffer.alloc(1024, 7)))
      await engine.archiveServiceOutputs(job, c, 'stop')
      expect(job.outputArchives).to.equal(undefined)
      expect(job.outputArchiveError).to.match(/^stop: /)
      expect(fs.readdirSync(folder())).to.deep.equal([])
    })
  })

  describe('getServiceResult', () => {
    async function engineWithArchive() {
      const engine = makeEngine(tempFolder)
      const job = makeJob({ status: ServiceStatusNumber.Stopped, containerId: '' })
      await engine.archiveServiceOutputs(job, outputsContainer('c1'), 'stop')
      engine.db.getServiceJob.resolves([job])
      return { engine, job }
    }

    async function refused(p: Promise<unknown>): Promise<ServiceResultError> {
      try {
        await p
      } catch (e) {
        expect(e).to.be.instanceOf(ServiceResultError)
        return e
      }
      throw new Error('expected a ServiceResultError')
    }

    it('streams an archive, resumable from an offset', async () => {
      const { engine, job } = await engineWithArchive()
      const full = await engine.getServiceResult(SERVICE_ID, OWNER, 0)
      expect(full.headers['Content-Type']).to.equal('application/zip')
      expect(full.headers['Content-Disposition']).to.contain(
        `${SERVICE_ID}-outputs-0.zip`
      )
      const bytes = await streamToBuffer(full.stream)
      expect(bytes.length).to.equal(job.outputArchives[0].filesize)

      const rest = await engine.getServiceResult(SERVICE_ID, OWNER, 0, 10)
      expect(rest.headers['Content-Length']).to.equal(String(bytes.length - 10))
      expect((await streamToBuffer(rest.stream)).equals(bytes.subarray(10))).to.equal(
        true
      )
    })

    it('refuses an unknown index, and an offset past the end', async () => {
      const { engine, job } = await engineWithArchive()
      expect(
        (await refused(engine.getServiceResult(SERVICE_ID, OWNER, 1))).httpStatus
      ).to.equal(404)
      const past = job.outputArchives[0].filesize + 1
      expect(
        (await refused(engine.getServiceResult(SERVICE_ID, OWNER, 0, past))).httpStatus
      ).to.equal(416)
    })

    it('returns null for an unknown service', async () => {
      const engine = makeEngine(tempFolder)
      expect(await engine.getServiceResult(SERVICE_ID, OWNER, 0)).to.equal(null)
    })

    it('zips the running container live', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([makeJob()])
      engine.docker.getContainer.returns(outputsContainer('c1'))
      const live = await engine.getServiceResult(SERVICE_ID, OWNER, 'live')
      expect(live.headers['Content-Disposition']).to.contain('outputs-live.zip')
      const entries = await readZip(await streamToBuffer(live.stream))
      expect(entries.find((e) => e.name === 'images/a.png').content).to.equal('png-bytes')
      // live downloads never touch the node's disk
      expect(fs.existsSync(path.join(tempFolder, CLUSTER_HASH, 'services'))).to.equal(
        false
      )
    })

    it('refuses a live download without a container, or with an output bucket', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([
        makeJob({ status: ServiceStatusNumber.Stopped, containerId: '' })
      ])
      expect(
        (await refused(engine.getServiceResult(SERVICE_ID, OWNER, 'live'))).httpStatus
      ).to.equal(409)
      engine.db.getServiceJob.resolves([makeJob({ outputBucketId: 'bucket-1' })])
      expect(
        (await refused(engine.getServiceResult(SERVICE_ID, OWNER, 'live'))).httpStatus
      ).to.equal(400)
    })
  })

  describe('cleanupExpiredServiceOutputs', () => {
    const STORAGE_EXPIRY = 3600 // seconds

    async function expiredService(expiredAgo: number) {
      const engine = makeEngine(tempFolder)
      engine.getComputeEnvironments = sinon
        .stub()
        .resolves([{ id: 'env-1', storageExpiry: STORAGE_EXPIRY }])
      const job = makeJob({
        status: ServiceStatusNumber.Expired,
        containerId: '',
        expiresAt: Date.now() - expiredAgo
      })
      await engine.archiveServiceOutputs(job, outputsContainer('c1'), 'expiry')
      engine.db.getServiceJob.resolves([job])
      engine.db.getExpiredServiceJobsBefore.resolves([job])
      return { engine, job }
    }

    it('deletes the archives once storageExpiry has elapsed since expiresAt, keeping the record', async () => {
      const { engine, job } = await expiredService(STORAGE_EXPIRY * 1000 + 1000)
      expect(await engine.cleanupExpiredServiceOutputs()).to.equal(1)
      expect(job.outputArchives).to.deep.equal([])
      expect(job.outputsDeletedAt).to.be.a('number')
      expect(
        fs.existsSync(path.join(tempFolder, CLUSTER_HASH, 'services', SERVICE_ID))
      ).to.equal(false)
      sinon.assert.calledWith(engine.db.updateServiceJob, job)
      // the query is bounded by the shortest storage expiry
      const [expiresBefore] = engine.db.getExpiredServiceJobsBefore.firstCall.args
      expect(expiresBefore).to.be.closeTo(Date.now() - STORAGE_EXPIRY * 1000, 1000)
    })

    it('keeps the archives until then', async () => {
      const { engine, job } = await expiredService(STORAGE_EXPIRY * 1000 - 60_000)
      expect(await engine.cleanupExpiredServiceOutputs()).to.equal(0)
      expect(job.outputArchives).to.have.lengthOf(1)
      sinon.assert.notCalled(engine.db.updateServiceJob)
    })
  })
})
