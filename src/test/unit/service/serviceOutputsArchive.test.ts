import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import * as tarStream from 'tar-stream'
import yauzl from 'yauzl'
import yazl from 'yazl'
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

    it('fails the zip stream, without an unhandled error, when the tar ends inside a file', async () => {
      const tar = await makeTar([
        { name: 'outputs', type: 'directory' },
        { name: 'outputs/big.bin', content: 'x'.repeat(64 * 1024) }
      ])
      const uncaught = sinon.spy()
      process.prependListener('uncaughtException', uncaught)
      let error: Error
      try {
        await streamToBuffer(tarToZip(Readable.from(tar.subarray(0, 512 + 1024))))
      } catch (e) {
        error = e
      } finally {
        await new Promise((resolve) => setImmediate(resolve))
        process.removeListener('uncaughtException', uncaught)
      }
      expect(uncaught.called).to.equal(false)
      expect(error?.message).to.equal('Unexpected end of data')
    })

    it('fails the zip stream, without an unhandled error, when yazl itself errors', async () => {
      // yazl emits its own failures on the ZipFile, not on its outputStream
      sinon.stub(yazl.ZipFile.prototype, 'end').callsFake(function (this: yazl.ZipFile) {
        this.emit('error', new Error('zip failed'))
      })
      const uncaught = sinon.spy()
      process.prependListener('uncaughtException', uncaught)
      let error: Error
      try {
        await streamToBuffer(tarToZip(Readable.from(await makeTar(OUTPUTS_TAR))))
      } catch (e) {
        error = e
      } finally {
        await new Promise((resolve) => setImmediate(resolve))
        process.removeListener('uncaughtException', uncaught)
      }
      expect(uncaught.called).to.equal(false)
      expect(error?.message).to.equal('zip failed')
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
        containerId: 'c1'
      })
      const file = path.join(folder(), 'outputs-0.zip')
      expect(archive.filesize).to.equal(fs.statSync(file).size)
      expect(fs.existsSync(file + '.partial')).to.equal(false)
      const entries = await readZip(fs.readFileSync(file))
      expect(entries.find((e) => e.name === 'result.txt').content).to.equal('hello')
    })

    it('the expiry teardown archives the container', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob({ expiresAt: Date.now() - 1000 })
      engine.db.getServiceJob.resolves([job])
      engine.docker.getContainer.returns(outputsContainer('c1'))
      const stopped = await engine.stopService(SERVICE_ID, OWNER, true)
      expect(stopped.outputArchives).to.have.lengthOf(1)
      expect(stopped.outputArchives[0].containerId).to.equal('c1')
    })

    it('numbers archives per container and never archives the same container twice', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      await engine.archiveServiceOutputs(job, outputsContainer('c1'))
      await engine.archiveServiceOutputs(job, outputsContainer('c1')) // retried teardown
      await engine.archiveServiceOutputs(job, outputsContainer('c2'))
      expect(job.outputArchives.map((a) => [a.index, a.containerId])).to.deep.equal([
        [0, 'c1'],
        [1, 'c2']
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
      await engine.archiveServiceOutputs(job, c)
      sinon.assert.notCalled(c.getArchive)
      expect(job.outputArchives).to.equal(undefined)
    })

    it('treats a missing /data/outputs as nothing to archive', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      const c = outputsContainer('c1')
      c.getArchive = sinon.stub().rejects(dockerError(404))
      await engine.archiveServiceOutputs(job, c)
      expect(job.outputArchives).to.equal(undefined)
    })

    it('logs a failure without throwing and leaves no partial file', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      const c = outputsContainer('c1')
      c.getArchive = sinon.stub().resolves(Readable.from(Buffer.alloc(1024, 7)))
      await engine.archiveServiceOutputs(job, c)
      expect(job.outputArchives).to.equal(undefined)
      expect(fs.readdirSync(folder())).to.deep.equal([])
    })
  })

  describe('getServiceResult', () => {
    async function engineWithArchive() {
      const engine = makeEngine(tempFolder)
      const job = makeJob({ status: ServiceStatusNumber.Stopped, containerId: '' })
      await engine.archiveServiceOutputs(job, outputsContainer('c1'))
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
      await engine.archiveServiceOutputs(job, outputsContainer('c1'))
      engine.db.getServiceJob.resolves([job])
      engine.db.getExpiredServiceJobsBefore.resolves([job])
      return { engine, job }
    }

    it('deletes the archives once storageExpiry has elapsed since expiresAt, keeping the record', async () => {
      const { engine, job } = await expiredService(STORAGE_EXPIRY * 1000 + 1000)
      expect(await engine.cleanupExpiredServiceOutputs()).to.equal(1)
      expect(job.outputArchives).to.deep.equal([])
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

  describe('restart carries /data/outputs over', () => {
    // A created (not yet started) container: /data already exists, so ensureServiceOutputsFolder
    // puts nothing, and the carried-over tar is the only putArchive.
    function newContainer(overrides: Record<string, any> = {}) {
      return {
        id: 'new',
        infoArchive: sinon.stub().resolves({}),
        putArchive: sinon.stub().resolves(undefined),
        getArchive: sinon
          .stub()
          .callsFake(async () => Readable.from(await makeTar(OUTPUTS_TAR))),
        start: sinon.stub().resolves(undefined),
        stop: sinon.stub().resolves(undefined),
        remove: sinon.stub().resolves(undefined),
        ...overrides
      }
    }

    function restartEngine(old: any, created: any) {
      const engine = makeEngine(tempFolder)
      engine.docker.getContainer.callsFake((id: string) =>
        id === created.id ? created : old
      )
      engine.docker.createNetwork = sinon.stub().resolves({ id: 'newnet' })
      engine.docker.createContainer = sinon.stub().resolves(created)
      engine.pullImageRef = sinon.stub().resolves(undefined)
      return engine
    }

    it('copies the old container folder into the new one before starting it, and archives nothing', async () => {
      const old = outputsContainer('old')
      const created = newContainer()
      const engine = restartEngine(old, created)
      const job = makeJob({ containerId: 'old' })

      await engine.doRestartService(job)

      expect(job.status).to.equal(ServiceStatusNumber.Running)
      expect(job.containerId).to.equal('new')
      expect(job.previousContainerId).to.equal(undefined)
      expect(job.outputArchives ?? []).to.deep.equal([])
      sinon.assert.calledOnce(created.putArchive)
      expect(created.putArchive.firstCall.args[1]).to.deep.equal({ path: '/data' })
      // the old folder is read only after the old container stopped; it is removed only once
      // the copy landed, and the new container starts last
      sinon.assert.callOrder(
        old.stop,
        old.getArchive,
        created.putArchive,
        old.remove,
        created.start
      )
      // the switch to the new container is persisted before the old one is removed
      const switched = engine.db.updateServiceJob
        .getCalls()
        .findIndex((c: any) => c.args[0].containerId === 'new')
      expect(switched).to.be.greaterThan(-1)
      expect(
        engine.db.updateServiceJob.getCall(switched).calledBefore(old.remove.firstCall)
      ).to.equal(true)
    })

    it('archives the old folder instead when the copy fails, and still restarts', async () => {
      const old = outputsContainer('old')
      const created = newContainer({
        putArchive: sinon.stub().rejects(new Error('disk full'))
      })
      const engine = restartEngine(old, created)
      const job = makeJob({ containerId: 'old' })

      await engine.doRestartService(job)

      expect(job.status).to.equal(ServiceStatusNumber.Running)
      expect(job.outputArchives.map((a) => a.containerId)).to.deep.equal(['old'])
      sinon.assert.calledOnce(old.remove)
    })

    it('archives the old folder up front when the old container cannot be stopped', async () => {
      // A failed stop may leave it running, and the network teardown force-removes a
      // container still attached — so it must not be kept around for the carry-over.
      const daemonError: any = new Error('docker 500')
      daemonError.statusCode = 500
      const old = { ...outputsContainer('old'), stop: sinon.stub().rejects(daemonError) }
      const created = newContainer()
      const engine = restartEngine(old, created)
      const job = makeJob({ containerId: 'old' })

      await engine.doRestartService(job)

      expect(job.status).to.equal(ServiceStatusNumber.Running)
      expect(job.containerId).to.equal('new')
      expect(job.previousContainerId).to.equal(undefined)
      expect(job.outputArchives.map((a) => a.containerId)).to.deep.equal(['old'])
      sinon.assert.notCalled(created.putArchive)
      sinon.assert.callOrder(old.getArchive, old.remove, created.start)
    })

    it('still carries the folder over when the old container was already stopped (304)', async () => {
      const alreadyStopped: any = new Error('docker 304')
      alreadyStopped.statusCode = 304
      const old = {
        ...outputsContainer('old'),
        stop: sinon.stub().rejects(alreadyStopped)
      }
      const created = newContainer()
      const engine = restartEngine(old, created)
      const job = makeJob({ containerId: 'old' })

      await engine.doRestartService(job)

      expect(job.status).to.equal(ServiceStatusNumber.Running)
      expect(job.outputArchives ?? []).to.deep.equal([])
      sinon.assert.calledOnce(created.putArchive)
    })

    it('a restart failing before the copy archives the old container', async () => {
      const old = outputsContainer('old')
      const created = newContainer()
      const engine = restartEngine(old, created)
      engine.pullImageRef = sinon.stub().rejects(new Error('pull failed'))
      const job = makeJob({ containerId: 'old' })

      let error: Error
      try {
        await engine.doRestartService(job)
      } catch (e) {
        error = e
      }
      expect(error.message).to.equal('pull failed')
      expect(job.status).to.equal(ServiceStatusNumber.Error)
      expect(job.outputArchives.map((a) => a.containerId)).to.deep.equal(['old'])
      sinon.assert.calledOnce(old.remove)
      expect(job.previousContainerId).to.equal(undefined)
    })

    it('a restart failing after the copy archives the new container, which holds the results', async () => {
      const old = outputsContainer('old')
      const created = newContainer({
        start: sinon.stub().rejects(new Error('start failed'))
      })
      const engine = restartEngine(old, created)
      const job = makeJob({ containerId: 'old' })

      let error: Error
      try {
        await engine.doRestartService(job)
      } catch (e) {
        error = e
      }
      expect(error.message).to.equal('start failed')
      expect(job.status).to.equal(ServiceStatusNumber.Error)
      expect(job.containerId).to.equal('')
      expect(job.outputArchives.map((a) => a.containerId)).to.deep.equal(['new'])
    })

    it('a service with an output bucket removes the old container right away, copying nothing', async () => {
      const old = outputsContainer('old')
      const created = newContainer()
      const engine = restartEngine(old, created)
      engine.serviceOutputMounts = sinon.stub().resolves([])
      const job = makeJob({ containerId: 'old', outputBucketId: 'bucket-1' })

      await engine.doRestartService(job)

      expect(job.status).to.equal(ServiceStatusNumber.Running)
      sinon.assert.notCalled(old.getArchive)
      sinon.assert.notCalled(created.putArchive)
      sinon.assert.callOrder(old.remove, created.start)
    })

    it('orphan recovery archives the previous container when a restart died before switching', async () => {
      const old = outputsContainer('old')
      const engine = makeEngine(tempFolder)
      engine.docker.getContainer.returns(old)
      const job = makeJob({
        containerId: '',
        previousContainerId: 'old',
        status: ServiceStatusNumber.PullImage,
        statusText: 'PullImage'
      })
      engine.db.getServiceJob.resolves([job])

      await engine.processServiceStart(job)

      expect(job.status).to.equal(ServiceStatusNumber.Error)
      expect(job.outputArchives.map((a) => a.containerId)).to.deep.equal(['old'])
      sinon.assert.calledOnce(old.remove)
      expect(job.previousContainerId).to.equal(undefined)
    })
  })

  it('an empty /data/outputs produces no archive', async () => {
    const engine = makeEngine(tempFolder)
    const job = makeJob()
    await engine.archiveServiceOutputs(
      job,
      outputsContainer('c1', [{ name: 'outputs', type: 'directory' }])
    )
    expect(job.outputArchives ?? []).to.deep.equal([])
    expect(
      fs.existsSync(
        path.join(tempFolder, CLUSTER_HASH, 'services', SERVICE_ID, 'outputs-0.zip')
      )
    ).to.equal(false)
  })
})
