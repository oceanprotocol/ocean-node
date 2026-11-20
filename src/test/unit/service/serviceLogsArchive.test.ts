/* eslint-disable security/detect-non-literal-fs-filename */
import { expect } from 'chai'
import sinon from 'sinon'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PassThrough, Readable } from 'stream'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import {
  collectServiceLogs,
  encodeDockerLogFrame,
  readDockerLogFrames,
  savedServiceLogsStream,
  SERVICE_LOGS_MAX_BYTES,
  SERVICE_LOGS_TAIL_ENTRIES,
  splitLogTimestamp
} from '../../../components/c2d/serviceLogs.js'
import { ServiceStatusNumber, ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'

const OWNER = '0x0000000000000000000000000000000000000001'
const SERVICE_ID = 'svc-logs-1'
const CLUSTER_HASH = 'hash-logs'
const STDOUT = 1
const STDERR = 2

const T0 = '2026-11-17T10:00:00.000000001Z'
const T1 = '2026-11-17T10:00:01.000000001Z'
const T2 = '2026-11-17T10:00:02.000000001Z'
const T3 = '2026-11-17T11:00:00.000000001Z'

// Built by hand in the shape `container.logs({ timestamps: true })` sends, so no Docker is needed.
function entry(at: string, text: string, stream = STDOUT): Buffer {
  return encodeDockerLogFrame(stream, Buffer.from(`${at} ${text}\n`))
}

const LOG = Buffer.concat([
  entry(T0, 'booting'),
  entry(T1, 'warning', STDERR),
  entry(T2, 'ready')
])

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c)
  return Buffer.concat(chunks)
}

// [stream type, text] pairs, so a failing assertion shows readable log lines rather than bytes.
async function framesOf(
  source: Buffer | NodeJS.ReadableStream
): Promise<Array<[number, string]>> {
  const input = Buffer.isBuffer(source) ? Readable.from([source]) : source
  const frames: Array<[number, string]> = []
  for await (const f of readDockerLogFrames(input as AsyncIterable<Buffer>)) {
    frames.push([f.stream, f.payload.toString()])
  }
  return frames
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

// Built from the prototype so the constructor, which connects to Docker, never runs (same pattern
// as serviceOutputsArchive.test.ts).
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

// Its log stream ends after `log`, as a stopped container's does, so saving never waits on the
// idle timer. getArchive answers 404 to keep the outputs archive out of these tests.
function logsContainer(id: string, log: Buffer = LOG) {
  return {
    id,
    inspect: sinon.stub().resolves({}),
    stop: sinon.stub().resolves(undefined),
    remove: sinon.stub().resolves(undefined),
    getArchive: sinon.stub().rejects(dockerError(404)),
    logs: sinon.stub().callsFake(() => Promise.resolve(Readable.from([log])))
  }
}

// The containers whose saved logs had been persisted by the time `removal` was first called. The
// job is one mutable object, so what each update wrote is copied as it happens.
function recordsBefore(engine: any, removal: sinon.SinonStub): () => string[] {
  let recorded: string[] = []
  engine.db.updateServiceJob.callsFake((job: ServiceJob) => {
    if (!removal.called) recorded = (job.logArchives ?? []).map((a) => a.containerId)
    return Promise.resolve(1)
  })
  return () => recorded
}

// A container a restart creates: no log yet, and nothing in /data/outputs.
function createdContainer(id = 'new') {
  return {
    id,
    infoArchive: sinon.stub().resolves({}),
    putArchive: sinon.stub().resolves(undefined),
    start: sinon.stub().resolves(undefined),
    stop: sinon.stub().resolves(undefined),
    remove: sinon.stub().resolves(undefined)
  }
}

// An engine whose restart replaces `old` with `created`, with nothing to pull.
function restartEngine(tempFolder: string, old: any, created: any): any {
  const engine = makeEngine(tempFolder)
  engine.docker.getContainer.callsFake((id: string) =>
    id === created.id ? created : old
  )
  engine.docker.createNetwork = sinon.stub().resolves({ id: 'newnet' })
  engine.docker.createContainer = sinon.stub().resolves(created)
  engine.pullImageRef = sinon.stub().resolves(undefined)
  return engine
}

describe('service logs saved at teardown', () => {
  let tempFolder: string
  const folder = () => path.join(tempFolder, CLUSTER_HASH, 'services', SERVICE_ID)

  beforeEach(() => {
    tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-svc-logs-'))
  })
  afterEach(() => {
    sinon.restore()
    fs.rmSync(tempFolder, { recursive: true, force: true })
  })

  describe('helpers', () => {
    it('reads frames split across chunks, and refuses a stream that is not multiplexed', async () => {
      const chunks: Buffer[] = []
      for (let i = 0; i < LOG.length; i += 5) chunks.push(LOG.subarray(i, i + 5))
      expect(await framesOf(Readable.from(chunks))).to.deep.equal([
        [STDOUT, `${T0} booting\n`],
        [STDERR, `${T1} warning\n`],
        [STDOUT, `${T2} ready\n`]
      ])

      let error: Error | undefined
      try {
        await framesOf(Buffer.from('raw output of a TTY container\n'))
      } catch (e) {
        error = e
      }
      expect(error?.message).to.equal('not a multiplexed Docker log stream')
    })

    it('splits off the timestamp Docker adds, and leaves a payload without one alone', () => {
      const stamped = splitLogTimestamp(Buffer.from(`${T1} hello\n`))
      expect(stamped.ms).to.equal(Date.parse('2026-11-17T10:00:01.000Z'))
      expect(stamped.body.toString()).to.equal('hello\n')

      const plain = splitLogTimestamp(Buffer.from('no timestamp here\n'))
      expect(plain.ms).to.equal(undefined)
      expect(plain.body.toString()).to.equal('no timestamp here\n')
    })

    it('collects a whole log that fits', async () => {
      const collected = await collectServiceLogs(Readable.from([LOG]))
      expect(collected.data.equals(LOG)).to.equal(true)
      expect(collected.droppedBytes).to.equal(0)
      expect(collected.cutShort).to.equal(false)
      expect((await collectServiceLogs(Readable.from([]))).data.length).to.equal(0)
    })

    it('keeps the newest whole frames of a log over the limit, with a note on what was dropped', async () => {
      const first = entry(T0, 'booting')
      const collected = await collectServiceLogs(Readable.from([LOG]), {
        maxBytes: LOG.length - first.length
      })
      expect(collected.droppedBytes).to.equal(first.length)
      const frames = await framesOf(collected.data)
      expect(frames.slice(1)).to.deep.equal([
        [STDERR, `${T1} warning\n`],
        [STDOUT, `${T2} ready\n`]
      ])
      // stamped like the first entry it precedes, so `since` keeps or drops the two together
      const [noteStream, note] = frames[0]
      expect(noteStream).to.equal(STDERR)
      expect(note).to.match(
        /^2026-11-17T10:00:01\.000Z \[ocean-node\] \d+ bytes of older output/
      )
      expect(note).to.contain(`${first.length} bytes`)
    })

    it('says "at least" once the read reaches the tail Docker was asked for, as older entries may be missing', async () => {
      const first = entry(T0, 'booting')
      const trim = { maxBytes: LOG.length - first.length }
      // three entries read: below a tail of 4 the count is exact, at a tail of 3 it is a bound
      const exact = await collectServiceLogs(Readable.from([LOG]), { ...trim, tail: 4 })
      const bound = await collectServiceLogs(Readable.from([LOG]), { ...trim, tail: 3 })
      const [[, exactNote]] = await framesOf(exact.data)
      const [[, boundNote]] = await framesOf(bound.data)
      expect(exactNote).to.contain(`[ocean-node] ${first.length} bytes`)
      expect(boundNote).to.contain(`[ocean-node] at least ${first.length} bytes`)
      // the tail is sized so that the byte limit, not the tail, decides what is kept
      expect(SERVICE_LOGS_TAIL_ENTRIES * (8 + T0.length + 1)).to.be.greaterThan(
        SERVICE_LOGS_MAX_BYTES
      )
    })

    it('gives up on a log that never ends, keeping what it read', async () => {
      const live = new PassThrough()
      live.write(entry(T0, 'still running'))
      const collected = await collectServiceLogs(live, { idleMs: 50, maxMs: 1000 })
      expect(collected.cutShort).to.equal(true)
      expect(await framesOf(collected.data)).to.deep.equal([
        [STDOUT, `${T0} still running\n`]
      ])
      expect(live.destroyed).to.equal(true)
    })

    it('streams saved files oldest first, without timestamps, from `since` on', async () => {
      fs.mkdirSync(folder(), { recursive: true })
      const a = path.join(folder(), 'logs-0.log')
      const b = path.join(folder(), 'logs-1.log')
      fs.writeFileSync(a, LOG)
      fs.writeFileSync(b, entry(T3, 'second container'))

      expect(await framesOf(savedServiceLogsStream([a, b]))).to.deep.equal([
        [STDOUT, 'booting\n'],
        [STDERR, 'warning\n'],
        [STDOUT, 'ready\n'],
        [STDOUT, 'second container\n']
      ])
      // Unix seconds, the unit clients already send for Docker's own filter
      const since = Date.parse('2026-11-17T10:00:01Z') / 1000
      expect(await framesOf(savedServiceLogsStream([a, b], since))).to.deep.equal([
        [STDERR, 'warning\n'],
        [STDOUT, 'ready\n'],
        [STDOUT, 'second container\n']
      ])
    })

    it('skips a saved file deleted after the caller checked for it, instead of failing the stream', async () => {
      fs.mkdirSync(folder(), { recursive: true })
      const deleted = path.join(folder(), 'logs-0.log')
      const kept = path.join(folder(), 'logs-1.log')
      fs.writeFileSync(kept, entry(T3, 'second container'))
      expect(await framesOf(savedServiceLogsStream([deleted, kept]))).to.deep.equal([
        [STDOUT, 'second container\n']
      ])
    })
  })

  describe('saving', () => {
    it('stop saves the logs after stopping and before removing the container', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([makeJob()])
      const c = logsContainer('c1')
      engine.docker.getContainer.returns(c)
      const recordedBeforeRemoval = recordsBefore(engine, c.remove)

      const stopped = await engine.stopService(SERVICE_ID, OWNER)

      expect(stopped.status).to.equal(ServiceStatusNumber.Stopped)
      sinon.assert.callOrder(c.stop, c.logs, c.remove)
      sinon.assert.calledWithMatch(c.logs, {
        stdout: true,
        stderr: true,
        follow: true,
        timestamps: true,
        tail: SERVICE_LOGS_TAIL_ENTRIES
      })
      // the file must be on record before the container, the only other copy, is removed
      expect(recordedBeforeRemoval()).to.deep.equal(['c1'])
      expect(stopped.logArchives).to.have.lengthOf(1)
      const [saved] = stopped.logArchives
      expect(saved).to.include({ index: 0, filename: 'logs-0.log', containerId: 'c1' })
      expect(saved).to.not.have.property('droppedBytes')
      const file = path.join(folder(), 'logs-0.log')
      expect(fs.readFileSync(file).equals(LOG)).to.equal(true)
      expect(saved.filesize).to.equal(LOG.length)
      expect(fs.existsSync(file + '.partial')).to.equal(false)
      // persisted, or the file would sit on disk with no record pointing to it
      sinon.assert.calledWithMatch(engine.db.updateServiceJob, {
        status: ServiceStatusNumber.Stopped,
        logArchives: stopped.logArchives
      })
    })

    it('the expiry teardown saves the logs, for a service with an output bucket too', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([
        makeJob({ expiresAt: Date.now() - 1000, outputBucketId: 'bucket-1' })
      ])
      engine.docker.getContainer.returns(logsContainer('c1'))
      const stopped = await engine.stopService(SERVICE_ID, OWNER, true)
      expect(stopped.logArchives.map((a: any) => a.containerId)).to.deep.equal(['c1'])
      expect(stopped.outputArchives).to.equal(undefined)
    })

    it('numbers saved logs per container and never saves the same container twice', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      await engine.saveServiceLogs(job, logsContainer('c1'))
      await engine.saveServiceLogs(job, logsContainer('c1')) // retried teardown
      await engine.saveServiceLogs(job, logsContainer('c2'))
      expect(job.logArchives.map((a) => [a.index, a.containerId])).to.deep.equal([
        [0, 'c1'],
        [1, 'c2']
      ])
      expect(fs.readdirSync(folder()).sort()).to.deep.equal(['logs-0.log', 'logs-1.log'])
    })

    it('saves nothing for a container that logged nothing, or is already gone', async () => {
      const engine = makeEngine(tempFolder)
      const job = makeJob()
      await engine.saveServiceLogs(job, logsContainer('c1', Buffer.alloc(0)))
      const gone = logsContainer('c2')
      gone.logs = sinon.stub().rejects(dockerError(404))
      await engine.saveServiceLogs(job, gone)
      expect(job.logArchives).to.equal(undefined)
      expect(fs.existsSync(folder())).to.equal(false)
    })

    it('logs a failure without throwing, and the teardown goes on', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([makeJob()])
      const c = logsContainer('c1', Buffer.from('not a multiplexed stream'))
      engine.docker.getContainer.returns(c)
      const stopped = await engine.stopService(SERVICE_ID, OWNER)
      expect(stopped.status).to.equal(ServiceStatusNumber.Stopped)
      expect(stopped.logArchives).to.equal(undefined)
      sinon.assert.calledOnce(c.remove)
      expect(fs.existsSync(folder())).to.equal(false)
    })

    it('a partial file that cannot be removed does not stop the teardown either', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([makeJob()])
      const c = logsContainer('c1')
      engine.docker.getContainer.returns(c)
      // A directory where the partial file goes: writing it fails, and so does rmSync on it.
      fs.mkdirSync(path.join(folder(), 'logs-0.log.partial', 'in-the-way'), {
        recursive: true
      })

      const stopped = await engine.stopService(SERVICE_ID, OWNER)

      expect(stopped.status).to.equal(ServiceStatusNumber.Stopped)
      expect(stopped.logArchives).to.equal(undefined)
      sinon.assert.calledOnce(c.remove)
    })

    it('restart saves the old container logs before removing it', async () => {
      const old = logsContainer('old')
      const created = createdContainer()
      const engine = restartEngine(tempFolder, old, created)
      const job = makeJob({ containerId: 'old' })

      await engine.doRestartService(job)

      expect(job.status).to.equal(ServiceStatusNumber.Running)
      expect(job.containerId).to.equal('new')
      expect(job.logArchives.map((a) => a.containerId)).to.deep.equal(['old'])
      sinon.assert.callOrder(old.stop, old.logs, old.remove, created.start)
    })

    it('a bucket restart records the old log before removing that container, and the new container before starting it', async () => {
      const old = logsContainer('old')
      const created = createdContainer()
      const engine = restartEngine(tempFolder, old, created)
      // What each update wrote, copied as it happens: the job is one mutable object.
      const writes: Array<{
        savedLogs: string[]
        containerId: string
        oldRemoved: boolean
        newStarted: boolean
      }> = []
      engine.db.updateServiceJob.callsFake((j: ServiceJob) => {
        writes.push({
          savedLogs: (j.logArchives ?? []).map((a) => a.containerId),
          containerId: j.containerId,
          oldRemoved: old.remove.called,
          newStarted: created.start.called
        })
        return Promise.resolve(1)
      })
      // With a bucket there is no carry-over, so the old container is removed straight away. The
      // bucket mount itself needs a running node, and is not what this checks.
      const job = makeJob({ containerId: 'old', outputBucketId: 'bucket-1' })
      engine.serviceOutputMounts = sinon.stub().resolves([])

      await engine.doRestartService(job)

      expect(job.status).to.equal(ServiceStatusNumber.Running)
      expect(writes.some((w) => !w.oldRemoved && w.savedLogs.includes('old'))).to.equal(
        true
      )
      // orphan recovery needs the id to save the new container's log if the node dies now
      expect(writes.some((w) => !w.newStarted && w.containerId === 'new')).to.equal(true)
    })
  })

  describe('getServiceStreamableLogs', () => {
    // Two saved containers, so the order they are served in can be checked.
    async function withSavedLogs(overrides: Partial<ServiceJob> = {}) {
      const engine = makeEngine(tempFolder)
      const job = makeJob({
        status: ServiceStatusNumber.Stopped,
        containerId: '',
        ...overrides
      })
      await engine.saveServiceLogs(job, logsContainer('c1'))
      await engine.saveServiceLogs(
        job,
        logsContainer('c2', entry(T3, 'second container'))
      )
      engine.db.getServiceJob.resolves([job])
      return { engine, job }
    }

    it('streams the live log while the service has a container', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([makeJob()])
      const c = logsContainer('c1')
      engine.docker.getContainer.returns(c)

      const stream = await engine.getServiceStreamableLogs(SERVICE_ID, OWNER, 1234)

      sinon.assert.calledWithMatch(c.logs, { follow: true, since: 1234 })
      expect(c.logs.firstCall.args[0]).to.not.have.property('timestamps')
      expect((await streamToBuffer(stream)).equals(LOG)).to.equal(true)
    })

    it('serves the saved logs once the containers are gone, oldest first, as a live stream would', async () => {
      const { engine } = await withSavedLogs()
      expect(
        await framesOf(await engine.getServiceStreamableLogs(SERVICE_ID, OWNER))
      ).to.deep.equal([
        [STDOUT, 'booting\n'],
        [STDERR, 'warning\n'],
        [STDOUT, 'ready\n'],
        [STDOUT, 'second container\n']
      ])
      const since = Date.parse('2026-11-17T11:00:00Z') / 1000
      expect(
        await framesOf(await engine.getServiceStreamableLogs(SERVICE_ID, OWNER, since))
      ).to.deep.equal([[STDOUT, 'second container\n']])
    })

    it('falls back to the saved logs when the container of an errored service is gone', async () => {
      const { engine } = await withSavedLogs({
        status: ServiceStatusNumber.Error,
        containerId: 'c3'
      })
      engine.docker.getContainer.returns({
        inspect: sinon.stub().rejects(dockerError(404))
      })
      const frames = await framesOf(
        await engine.getServiceStreamableLogs(SERVICE_ID, OWNER)
      )
      expect(frames).to.have.lengthOf(4)
    })

    it('streams the live log while a stop is still tearing the container down', async () => {
      const engine = makeEngine(tempFolder)
      engine.db.getServiceJob.resolves([
        makeJob({ status: ServiceStatusNumber.Stopping, containerId: 'c1' })
      ])
      const c = logsContainer('c1')
      engine.docker.getContainer.returns(c)

      const stream = await engine.getServiceStreamableLogs(SERVICE_ID, OWNER)

      sinon.assert.calledOnce(c.logs)
      expect((await streamToBuffer(stream)).equals(LOG)).to.equal(true)
    })

    it('reads the job again when the container went mid-request, for the log the teardown just saved', async () => {
      const { engine, job } = await withSavedLogs()
      // read while the container still existed, before the teardown recorded its log
      const stale = makeJob({ status: ServiceStatusNumber.Stopping, containerId: 'c2' })
      engine.db.getServiceJob.onFirstCall().resolves([stale])
      engine.db.getServiceJob.onSecondCall().resolves([job])
      engine.docker.getContainer.returns({
        inspect: sinon.stub().rejects(dockerError(404))
      })

      const frames = await framesOf(
        await engine.getServiceStreamableLogs(SERVICE_ID, OWNER)
      )

      expect(frames).to.have.lengthOf(4)
      sinon.assert.calledTwice(engine.db.getServiceJob)
    })

    it('rejects on a Docker failure rather than serving older logs, or none, in its place', async () => {
      // saved logs exist, so only the Docker error can be behind the rejection
      const { engine } = await withSavedLogs({
        status: ServiceStatusNumber.Running,
        containerId: 'c3'
      })
      engine.docker.getContainer.returns({
        inspect: sinon.stub().rejects(dockerError(500))
      })
      let error: Error | undefined
      try {
        await engine.getServiceStreamableLogs(SERVICE_ID, OWNER)
      } catch (e) {
        error = e
      }
      // generic: Docker's own message stays in the node's log
      expect(error?.message).to.equal(`Could not read the logs of service ${SERVICE_ID}`)
    })

    it('returns null when nothing was saved, or the files were deleted', async () => {
      const engine = makeEngine(tempFolder)
      expect(await engine.getServiceStreamableLogs(SERVICE_ID, OWNER)).to.equal(null)
      engine.db.getServiceJob.resolves([
        makeJob({ status: ServiceStatusNumber.Stopped, containerId: '' })
      ])
      expect(await engine.getServiceStreamableLogs(SERVICE_ID, OWNER)).to.equal(null)

      const saved = await withSavedLogs()
      fs.rmSync(folder(), { recursive: true, force: true })
      expect(await saved.engine.getServiceStreamableLogs(SERVICE_ID, OWNER)).to.equal(
        null
      )
    })
  })

  describe('cleanupExpiredServiceOutputs', () => {
    const STORAGE_EXPIRY = 3600 // seconds

    async function expiredService(expiredAgo: number) {
      const engine = makeEngine(tempFolder)
      engine.getComputeEnvironments = sinon
        .stub()
        .resolves([{ id: 'env-1', storageExpiry: STORAGE_EXPIRY }])
      // an output bucket leaves no output archives, so only the saved logs can trigger cleanup
      const job = makeJob({
        status: ServiceStatusNumber.Expired,
        containerId: '',
        outputBucketId: 'bucket-1',
        expiresAt: Date.now() - expiredAgo
      })
      await engine.saveServiceLogs(job, logsContainer('c1'))
      engine.db.getServiceJob.resolves([job])
      engine.db.getExpiredServiceJobsBefore.resolves([job])
      return { engine, job }
    }

    it('deletes the saved logs once storageExpiry has elapsed since expiresAt', async () => {
      const { engine, job } = await expiredService(STORAGE_EXPIRY * 1000 + 1000)
      expect(await engine.cleanupExpiredServiceOutputs()).to.equal(1)
      expect(job.logArchives).to.deep.equal([])
      expect(fs.existsSync(folder())).to.equal(false)
      sinon.assert.calledWith(engine.db.updateServiceJob, job)
      expect(await engine.getServiceStreamableLogs(SERVICE_ID, OWNER)).to.equal(null)
    })

    it('keeps them until then', async () => {
      const { engine, job } = await expiredService(STORAGE_EXPIRY * 1000 - 60_000)
      expect(await engine.cleanupExpiredServiceOutputs()).to.equal(0)
      expect(job.logArchives).to.have.lengthOf(1)
      sinon.assert.notCalled(engine.db.updateServiceJob)
    })
  })
})
