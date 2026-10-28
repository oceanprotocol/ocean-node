/* eslint-disable security/detect-non-literal-fs-filename */
import { expect } from 'chai'
import sinon from 'sinon'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceJob, ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import {
  createVolumeSizeCache,
  createServiceDiskMeasurementQueue,
  serviceDiskBackoffIntervalMs,
  serviceDiskCheckIntervalMs,
  SERVICE_DISK_MIN_INTERVAL_MS,
  SERVICE_DISK_MID_INTERVAL_MS,
  SERVICE_DISK_QUEUE_AGING_MS,
  measureServiceDiskUsage,
  serviceDiskMounts,
  SERVICE_DISK_CHECK_INTERVAL_MS
} from '../../../components/c2d/serviceDiskUsage.js'
import {
  toPublicServiceJob,
  toListedServiceJob
} from '../../../components/core/service/utils.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'

const GiB = 1024 ** 3

function makeJob(): ServiceJob {
  return {
    serviceId: 'disk-service',
    owner: 'owner',
    containerId: 'container',
    resources: [{ id: 'disk', amount: 20 }],
    status: ServiceStatusNumber.Running,
    statusText: 'Running',
    expiresAt: Date.now() + 3600_000,
    endpoints: []
  } as ServiceJob
}

function makeEngine(
  job: ServiceJob,
  inspect = sinon.stub().resolves({
    State: { Running: true },
    SizeRw: 21 * GiB,
    Mounts: []
  })
): any {
  const engine: any = Object.create(C2DEngineDocker.prototype)
  engine.serviceOpsInFlight = new Set()
  engine.serviceOpPromises = new Set()
  engine.serviceDiskCheckedAt = new Map()
  engine.serviceDiskSamples = new Map()
  engine.serviceDiskChecksInFlight = new Map()
  engine.serviceDiskUnmeasured = new Map()
  engine.db = {
    getServiceJob: sinon.stub().resolves([job]),
    updateServiceJob: sinon.stub().resolves(1),
    acquireServiceLock: sinon.stub().resolves(true),
    releaseServiceLock: sinon.stub().resolves()
  }
  engine.docker = {
    getContainer: sinon.stub().returns({ inspect }),
    modem: { dial: sinon.stub().yields(null, { Volumes: [] }) }
  }
  sinon
    .stub(engine, 'getServiceOutputsFolder')
    .returns('/missing-service-disk-test-folder')
  sinon.stub(engine, 'doStopService').resolves()
  return engine
}

async function runCheck(engine: any, job: ServiceJob): Promise<void> {
  engine.launchServiceDiskCheck(job)
  await Promise.all([...engine.serviceDiskChecksInFlight.values()])
}

describe('service disk quota enforcement', () => {
  afterEach(() => sinon.restore())

  it('exceed calls the manual stop path without releasing the reservation', async () => {
    const job = makeJob()
    const engine = makeEngine(job)
    await runCheck(engine, job)
    expect(
      engine.doStopService.calledOnceWith(
        job.serviceId,
        job.owner,
        false,
        false,
        ServiceStatusNumber.DiskQuotaExceeded
      )
    ).to.equal(true)
    expect(engine.db.releaseServiceLock.calledOnce).to.equal(true)
    expect(engine.serviceOpsInFlight.size).to.equal(0)
  })

  it('public status/list preserve 76 while hiding pending teardown state', () => {
    const job = {
      ...makeJob(),
      status: ServiceStatusNumber.DiskQuotaExceeded,
      statusText: 'DiskQuotaExceeded',
      terminationReason: ServiceStatusNumber.DiskQuotaExceeded as const
    }
    for (const publicJob of [toPublicServiceJob(job), toListedServiceJob(job)]) {
      expect(publicJob.status).to.equal(ServiceStatusNumber.DiskQuotaExceeded)
      expect(publicJob.statusText).to.equal('DiskQuotaExceeded')
      expect(publicJob).not.to.have.property('terminationReason')
    }
  })

  it('under quota and exactly at quota do not stop', async () => {
    for (const size of [0, 19 * GiB, 20 * GiB]) {
      const job = makeJob()
      const engine = makeEngine(
        job,
        sinon.stub().resolves({ State: { Running: true }, SizeRw: size })
      )
      await runCheck(engine, job)
      expect(engine.doStopService.called).to.equal(false)
    }
  })

  it('missing, invalid, stopped or failed measurements never stop', async () => {
    const samples = [
      { State: { Running: true } },
      { State: { Running: true }, SizeRw: -1 },
      { State: { Running: true }, SizeRw: NaN },
      { State: { Running: false }, SizeRw: 100 * GiB }
    ]
    for (const sample of samples) {
      const job = makeJob()
      const engine = makeEngine(job, sinon.stub().resolves(sample))
      await runCheck(engine, job)
      expect(engine.doStopService.called).to.equal(false)
      // nothing to stop: the lifecycle lease is never taken
      expect(engine.db.acquireServiceLock.called).to.equal(false)
    }
    const job = makeJob()
    const engine = makeEngine(job, sinon.stub().rejects(new Error('container gone')))
    await runCheck(engine, job)
    expect(engine.doStopService.called).to.equal(false)
  })

  it('aborts a timed-out inspect without stopping', async () => {
    const clock = sinon.useFakeTimers()
    const inspect = sinon.stub().callsFake(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), {
            once: true
          })
        })
    )
    const timeout = sinon.stub(AbortSignal, 'timeout').callsFake(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('timeout')), 15_000)
      return controller.signal
    })
    const job = makeJob()
    const engine = makeEngine(job, inspect)
    engine.launchServiceDiskCheck(job)
    await clock.tickAsync(0)
    await clock.tickAsync(15_001)
    await Promise.all([...engine.serviceDiskChecksInFlight.values()])
    expect(timeout.calledOnce).to.equal(true)
    expect(engine.doStopService.called).to.equal(false)
    expect(engine.serviceOpsInFlight.size).to.equal(0)
  })

  it('throttles checks by adaptive cadence and prevents overlap without blocking caller', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    let resolveInspect: (sample: any) => void
    const inspect = sinon.stub().returns(
      new Promise((resolve) => {
        resolveInspect = resolve
      })
    )
    const job = makeJob()
    const engine = makeEngine(job, inspect)
    expect(engine.launchServiceDiskCheck(job)).to.equal(undefined)
    engine.launchServiceDiskCheck(job)
    await new Promise<void>((resolve) => setImmediate(resolve))
    clock.tick(SERVICE_DISK_CHECK_INTERVAL_MS * 2)
    engine.launchServiceDiskCheck(job)
    expect(inspect.calledOnce).to.equal(true)
    resolveInspect({ State: { Running: true }, SizeRw: 0 })
    await Promise.all([...engine.serviceDiskChecksInFlight.values()])
    await runCheck(engine, job)
    expect(inspect.calledTwice).to.equal(true)
    await runCheck(engine, job)
    expect(inspect.calledTwice).to.equal(true)
    clock.tick(SERVICE_DISK_CHECK_INTERVAL_MS)
    await runCheck(engine, job)
    expect(inspect.calledThrice).to.equal(true)
  })

  it('skips busy leases, stale containers, non-running services and nonpositive quotas', async () => {
    const job = makeJob()
    const engine = makeEngine(job)
    engine.serviceOpsInFlight.add(job.serviceId)
    await runCheck(engine, job)
    expect(engine.db.acquireServiceLock.called).to.equal(false)
    engine.serviceOpsInFlight.clear()
    // over quota, but another process holds the lease: no stop, re-measured next tick
    engine.db.acquireServiceLock.resolves(false)
    await runCheck(engine, job)
    expect(engine.docker.getContainer.calledOnce).to.equal(true)
    expect(engine.serviceDiskCheckedAt.has(job.serviceId)).to.equal(false)
    engine.db.acquireServiceLock.resolves(true)
    // a restart replaced the container, or the service was already disk-stopped
    for (const fresh of [
      { ...job, containerId: 'replacement' },
      { ...job, containerId: '', status: ServiceStatusNumber.DiskQuotaExceeded },
      { ...job, containerId: '', status: ServiceStatusNumber.Restarting }
    ]) {
      engine.serviceDiskCheckedAt.clear()
      engine.db.getServiceJob.resolves([fresh])
      await runCheck(engine, job)
    }
    expect(engine.db.releaseServiceLock.callCount).to.equal(3)
    engine.docker.getContainer.resetHistory()
    for (const amount of [0, -1, NaN]) {
      await runCheck(engine, { ...job, resources: [{ id: 'disk', amount }] })
    }
    for (const status of [
      ServiceStatusNumber.Stopped,
      ServiceStatusNumber.DiskQuotaExceeded,
      ServiceStatusNumber.Restarting
    ])
      await runCheck(engine, { ...job, status })
    await runCheck(engine, { ...job, containerId: '' })
    expect(engine.docker.getContainer.called).to.equal(false)
    expect(engine.doStopService.called).to.equal(false)
  })

  it('measures outside the lifecycle lease, so an owner operation is never rejected by it', async () => {
    let resolveInspect: (sample: any) => void
    const inspect = sinon.stub().returns(
      new Promise((resolve) => {
        resolveInspect = resolve
      })
    )
    const job = makeJob()
    const engine = makeEngine(job, inspect)
    engine.launchServiceDiskCheck(job)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(inspect.calledOnce).to.equal(true)
    // e.g. the owner's SERVICE_RESTART lands while the container is being sized
    expect(await engine.tryAcquireServiceLifecycleLock(job.serviceId)).to.equal(true)
    resolveInspect({ State: { Running: true }, SizeRw: 21 * GiB, Mounts: [] })
    await Promise.all([...engine.serviceDiskChecksInFlight.values()])
    // the over-quota sample yields to the owner's operation and is retried next tick
    expect(engine.doStopService.called).to.equal(false)
    expect(engine.serviceDiskCheckedAt.has(job.serviceId)).to.equal(false)
    await engine.releaseServiceLifecycleLock(job.serviceId)
    inspect.resolves({ State: { Running: true }, SizeRw: 21 * GiB, Mounts: [] })
    await runCheck(engine, job)
    expect(engine.doStopService.calledOnce).to.equal(true)
    expect(engine.serviceOpsInFlight.size).to.equal(0)
  })

  it('runs real stop/archive/network/allocation cleanup and keeps the disk reason on retry', async () => {
    const job = makeJob()
    const engine = makeEngine(job)
    engine.doStopService.restore()
    sinon.stub(engine, 'logServiceDockerState').resolves()
    sinon.stub(engine, 'captureFinalServiceSnapshot').resolves()
    const archive = sinon.stub(engine, 'archiveServiceOutputs').resolves()
    const network = sinon.stub(engine, 'removeServiceNetwork').resolves()
    const release = sinon.stub(engine, 'releaseCpus')
    const container = engine.docker.getContainer()
    container.stop = sinon.stub().onFirstCall().rejects(new Error('daemon busy'))
    container.stop.onSecondCall().resolves()
    container.remove = sinon.stub().resolves()
    await runCheck(engine, job)
    expect(job.status).to.equal(ServiceStatusNumber.Error)
    expect(job.terminationReason).to.equal(ServiceStatusNumber.DiskQuotaExceeded)
    expect(job.statusText).to.include('DiskQuotaExceeded')
    expect(job.expiresAt).to.be.greaterThan(Date.now())
    expect(release.called).to.equal(false)
    // Health ticks retry pending teardown before expiry, including after node restart.
    engine.db.getRunningServiceJobs = sinon.stub().resolves([job])
    engine.clusterConfig = { hash: 'hash' }
    engine.modelDownloadSampler = { retain: sinon.stub() }
    await engine.checkRunningServices()
    await Promise.all([...engine.serviceOpPromises])
    expect(job.status).to.equal(ServiceStatusNumber.DiskQuotaExceeded)
    expect(job.statusText).to.equal('DiskQuotaExceeded')
    expect(archive.calledOnceWith(job, container)).to.equal(true)
    // v: the image's anonymous volumes go with the container, or the disk stays used
    expect(container.remove.calledOnceWith({ force: true, v: true })).to.equal(true)
    expect(network.calledOnce).to.equal(true)
    expect(release.calledOnceWith(job.serviceId)).to.equal(true)
    expect(job.containerId).to.equal('')
  })

  // The compute1 repro: yanwk/comfyui-boot declares VOLUME /root, so ComfyUI-Manager's
  // downloads land in an anonymous volume — not in SizeRw — whose host path the node
  // (itself in Docker) cannot see.
  it('stops a ComfyUI-style service whose models fill an image-declared volume', async () => {
    const job = makeJob()
    const engine = makeEngine(
      job,
      sinon.stub().resolves({
        State: { Running: true },
        SizeRw: 300 * 1024 ** 2,
        Mounts: [
          {
            Type: 'volume',
            Name: 'anon-root',
            Source: '/var/lib/docker/volumes/anon-root/_data',
            Destination: '/root',
            RW: true,
            Mode: ''
          }
        ]
      })
    )
    engine.docker.modem.dial.yields(null, {
      Volumes: [
        { Name: 'anon-root', UsageData: { Size: 25 * GiB } },
        { Name: 'someone-else', UsageData: { Size: 500 * GiB } }
      ]
    })
    await runCheck(engine, job)
    expect(
      engine.doStopService.calledOnceWith(
        job.serviceId,
        job.owner,
        false,
        false,
        ServiceStatusNumber.DiskQuotaExceeded
      )
    ).to.equal(true)
    const [request] = engine.docker.modem.dial.firstCall.args
    expect(request.path).to.equal('/system/df?')
    expect(request.options).to.deep.equal({ type: 'volume' })
  })

  it('still enforces the writable layer when no mount can be sized, warning once', async () => {
    const warn = sinon.stub(CORE_LOGGER, 'warn')
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const job = makeJob()
    const mounts = [
      {
        Type: 'volume',
        Name: 'anon',
        Source: '/var/lib/docker/volumes/anon/_data',
        Destination: '/root',
        RW: true,
        Mode: ''
      },
      {
        Type: 'bind',
        Source: '/missing-service-disk-bind',
        Destination: '/cache',
        RW: true,
        Mode: ''
      }
    ]
    const inspect = sinon
      .stub()
      .resolves({ State: { Running: true }, SizeRw: 0, Mounts: mounts })
    const engine = makeEngine(job, inspect)
    engine.docker.modem.dial.yields(new Error('daemon busy'))
    await runCheck(engine, job)
    clock.tick(SERVICE_DISK_CHECK_INTERVAL_MS)
    await runCheck(engine, job)
    expect(engine.doStopService.called).to.equal(false)
    const unmeasured = warn.args.filter(([m]) => String(m).includes('could not size'))
    expect(unmeasured).to.have.length(1)
    expect(unmeasured[0][0]).to.include('volume anon')
    expect(unmeasured[0][0]).to.include('/missing-service-disk-bind')
    inspect.resolves({ State: { Running: true }, SizeRw: 21 * GiB, Mounts: mounts })
    clock.tick(SERVICE_DISK_CHECK_INTERVAL_MS)
    await runCheck(engine, job)
    expect(engine.doStopService.calledOnce).to.equal(true)
  })

  it('a disk stop moves no escrow funds and leaves the payment as claimed', async () => {
    const job = makeJob()
    job.payment = {
      chainId: 8996,
      token: '0xtoken',
      lockTx: '0xlock',
      claimTx: '0xclaim',
      cancelTx: '',
      cost: 5
    } as any
    const before = { ...job.payment }
    const { expiresAt } = job
    const resources = structuredClone(job.resources)
    const engine = makeEngine(job)
    engine.doStopService.restore()
    engine.escrow = new Proxy(
      {},
      {
        get: (_t, name) => () => {
          throw new Error(`escrow.${String(name)} called`)
        }
      }
    )
    sinon.stub(engine, 'logServiceDockerState').resolves()
    sinon.stub(engine, 'captureFinalServiceSnapshot').resolves()
    sinon.stub(engine, 'archiveServiceOutputs').resolves()
    sinon.stub(engine, 'removeServiceNetwork').resolves()
    sinon.stub(engine, 'releaseCpus')
    const container = engine.docker.getContainer()
    container.stop = sinon.stub().resolves()
    container.remove = sinon.stub().resolves()
    await runCheck(engine, job)
    expect(job.status).to.equal(ServiceStatusNumber.DiskQuotaExceeded)
    expect(job.payment).to.deep.equal(before)
    expect(job.expiresAt).to.equal(expiresAt)
    expect(job.resources).to.deep.equal(resources)
    expect(job.terminationReason).to.equal(undefined)
    await engine.stopService(job.serviceId, job.owner)
    expect(job.status).to.equal(ServiceStatusNumber.DiskQuotaExceeded)
    expect(job.expiresAt).to.be.greaterThan(Date.now())
  })
})

describe('service disk measurement ownership', () => {
  let folder: string
  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'service-disk-'))
  })
  afterEach(async () => {
    sinon.restore()
    await rm(folder, { recursive: true, force: true })
  })

  const mount = (
    Source: string,
    Destination: string,
    Type = 'bind',
    RW = true,
    Mode = '',
    Name?: string
  ): any => ({ Source, Destination, Type, RW, Mode, Name })

  it('excludes buckets, RO mounts and tmpfs; includes writable bind mounts and image volumes', () => {
    const mounts = [
      mount('/buckets/owner', '/data/outputs'),
      mount('/models', '/models', 'bind', false),
      mount('/patch', '/ocean', 'bind', true, 'ro'),
      mount('', '/dev/shm', 'tmpfs'),
      mount('/node/outputs', '/outputs'),
      mount('/docker/volumes/service', '/downloads', 'volume')
    ]
    expect(serviceDiskMounts(mounts, 'bucket').map((m) => m.Source)).to.deep.equal([
      '/node/outputs',
      '/docker/volumes/service'
    ])
    // without a bucket, a /data/outputs mount is node disk like any other
    expect(serviceDiskMounts([mounts[0]]).map((m) => m.Source)).to.deep.equal([
      '/buckets/owner'
    ])
  })

  it('counts live mounts once and excludes retained archives across restarts', async () => {
    const archive = path.join(folder, 'archive')
    const bind = path.join(folder, 'mount')
    await mkdir(archive)
    await mkdir(bind)
    await writeFile(path.join(archive, 'outputs.zip'), Buffer.alloc(8192, 1))
    await writeFile(path.join(bind, 'checkpoint'), Buffer.alloc(8192, 1))
    const mounts = [
      mount(bind, '/downloads'),
      mount(bind + '/', '/duplicate'),
      mount('/missing-bucket', '/data/outputs'),
      mount('/missing-ro', '/models', 'bind', false),
      mount('/var/lib/docker/volumes/v/_data', '/root', 'volume', true, '', 'v'),
      mount('/var/lib/docker/volumes/v/_data', '/root2', 'volume', true, '', 'v')
    ]
    const inspect = sinon
      .stub()
      .resolves({ State: { Running: true }, SizeRw: 100, Mounts: mounts })
    const volumeSizes = sinon.stub().resolves(new Map([['v', 1000]]))
    const job = { ...makeJob(), outputBucketId: 'bucket' }
    const used = await measureServiceDiskUsage({ inspect } as any, job, volumeSizes)
    expect(used.unmeasured).to.deep.equal([])
    expect(used.usedBytes).to.be.at.least(100 + 1000 + 8192)
    mounts.splice(1, 1)
    mounts.splice(-1, 1)
    expect(
      (await measureServiceDiskUsage({ inspect } as any, job, volumeSizes)).usedBytes
    ).to.equal(used.usedBytes)
    inspect.resolves({ State: { Running: true }, SizeRw: 100, Mounts: [] })
    expect((await measureServiceDiskUsage({ inspect } as any, job)).usedBytes).to.equal(
      100
    )
    // An archive larger than the live quota must not immediately stop a restarted service.
    const restarted = { ...job, resources: [{ id: 'disk', amount: 1000 / GiB }] }
    const engine = makeEngine(restarted, inspect)
    engine.getServiceOutputsFolder.returns(archive)
    await runCheck(engine, restarted)
    expect(engine.doStopService.called).to.equal(false)
    expect(inspect.firstCall.args[0].size).to.equal(true)
    expect(inspect.firstCall.args[0].abortSignal).to.be.instanceOf(AbortSignal)
  })

  it('counts what it can and reports mounts it cannot size instead of voiding the sample', async () => {
    const inspect = sinon.stub().resolves({
      State: { Running: true },
      SizeRw: 100,
      Mounts: [
        mount('/missing-node-volume', '/downloads', 'volume', true, '', 'gone'),
        mount('/missing-node-bind', '/cache'),
        mount('', '/nosource')
      ]
    })
    const used = await measureServiceDiskUsage(
      { inspect } as any,
      makeJob(),
      sinon.stub().rejects(new Error('df failed'))
    )
    expect(used.usedBytes).to.equal(100)
    expect(used.unmeasured).to.have.members([
      'volume gone',
      'bind (no source)',
      '/missing-node-bind'
    ])
  })

  it('refreshes volumes when a writable bind pushes aggregate usage near quota', async () => {
    await writeFile(path.join(folder, 'live-data'), Buffer.alloc(16384, 1))
    const inspect = sinon.stub().resolves({
      State: { Running: true },
      SizeRw: 0,
      Mounts: [mount(folder, '/cache'), mount('', '/root', 'volume', true, '', 'v')]
    })
    const sizes = sinon.stub().resolves(new Map([['v', 1]]))
    const job = { ...makeJob(), resources: [{ id: 'disk', amount: 20000 / GiB }] }
    await measureServiceDiskUsage({ inspect } as any, job, sizes)
    expect(sizes.calledTwice).to.equal(true)
    expect(sizes.lastCall.args[0].forceFresh).to.equal(true)
  })

  it('shares one volume df per ttl, and does not cache a failed one', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const dial = sinon.stub()
    dial.onFirstCall().yields(new Error('daemon busy'))
    dial.yields(null, {
      Volumes: [
        { Name: 'a', UsageData: { Size: 7 } },
        { Name: 'unsized', UsageData: { Size: -1 } },
        { Name: 'nodata' }
      ]
    })
    const sizes = createVolumeSizeCache({ modem: { dial } } as any, 1000)
    try {
      await sizes()
      expect.fail('expected the first df to reject')
    } catch (e: any) {
      expect(e.message).to.equal('daemon busy')
    }
    const [first, second] = await Promise.all([sizes(), sizes()])
    expect(first).to.equal(second)
    expect([...first]).to.deep.equal([['a', 7]])
    expect(dial.callCount).to.equal(2)
    clock.tick(999)
    await sizes()
    expect(dial.callCount).to.equal(2)
    clock.tick(1)
    await sizes()
    expect(dial.callCount).to.equal(3)
  })
})

describe('adaptive service disk polling', () => {
  afterEach(() => sinon.restore())

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  const volumeMount = {
    Type: 'volume',
    Name: 'models',
    Destination: '/root',
    RW: true,
    Mode: ''
  }

  it('selects usage bands, growth prediction, jitter and strict interval bounds', () => {
    const interval = (ratio: number, growth = 0, random = 0) =>
      serviceDiskCheckIntervalMs(ratio * 100 * GiB, 100 * GiB, growth, random)
    expect(interval(0.49)).to.equal(SERVICE_DISK_CHECK_INTERVAL_MS)
    expect(interval(0.5)).to.equal(SERVICE_DISK_MID_INTERVAL_MS)
    expect(interval(0.799)).to.equal(SERVICE_DISK_MID_INTERVAL_MS)
    expect(interval(0.8)).to.equal(SERVICE_DISK_MIN_INTERVAL_MS)
    expect(interval(1.1)).to.equal(SERVICE_DISK_MIN_INTERVAL_MS)
    // 60 GiB free / 6 GiB/s = 10s until quota; sample halfway there.
    expect(interval(0.4, 6 * GiB)).to.equal(5000)
    expect(interval(0.4, 100 * GiB)).to.equal(SERVICE_DISK_MIN_INTERVAL_MS)
    expect(interval(0.1, 0, 1)).to.equal(27_000)
    expect(interval(0.5, 0, 1)).to.equal(9000)
    expect(interval(0.8, 0, 1)).to.equal(SERVICE_DISK_MIN_INTERVAL_MS)
    // Growth floor still shortens cadence for tiny quotas, even without history.
    expect(serviceDiskCheckIntervalMs(0, 4 * 1024 ** 2, 0, 0)).to.equal(2000)
  })

  it('launches first sample immediately on first Running tick and learns recent growth', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    sinon.stub(Math, 'random').returns(0)
    const job = makeJob()
    const inspect = sinon.stub().resolves({ State: { Running: true }, SizeRw: 0 })
    const engine = makeEngine(job, inspect)
    const at = Date.now()
    expect(engine.launchServiceDiskCheck(job)).to.equal(undefined)
    await Promise.all([...engine.serviceDiskChecksInFlight.values()])
    expect(inspect.calledOnce).to.equal(true)
    expect(engine.serviceDiskCheckedAt.get(job.serviceId) - at).to.be.lessThan(5000)
    clock.tick(30_000)
    inspect.resolves({ State: { Running: true }, SizeRw: 8 * GiB })
    await runCheck(engine, job)
    const sample = engine.serviceDiskSamples.get(job.serviceId)
    expect(sample.growthBytesPerSecond).to.equal((8 * GiB) / 30)
    expect(sample.intervalMs).to.equal(22_500)
    clock.tick(22_499)
    await runCheck(engine, job)
    expect(inspect.calledTwice).to.equal(true)
    clock.tick(1)
    await runCheck(engine, job)
    expect(inspect.calledThrice).to.equal(true)
  })

  it('bounds cache age by current cadence and forces near-quota and predicted-crossing scans', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    sinon.stub(Math, 'random').returns(0)
    const job = makeJob()
    const inspect = sinon.stub().resolves({
      State: { Running: true },
      SizeRw: 0,
      Mounts: [volumeMount]
    })
    const engine = makeEngine(job, inspect)
    const sizes = sinon.stub().resolves(new Map([['models', 10 * GiB]]))
    engine.serviceVolumeSizes = sizes
    await runCheck(engine, job)
    expect(sizes.firstCall.args[0]).to.include({ maxAgeMs: 30_000, forceFresh: true })
    clock.tick(10_000)
    await runCheck(engine, job)
    expect(sizes.secondCall.args[0]).to.include({ maxAgeMs: 10_000, forceFresh: false })
    sizes.resolves(new Map([['models', 18 * GiB]]))
    clock.tick(10_000)
    await runCheck(engine, job)
    // Discovering pressure in a cached sample refreshes within this same check.
    expect(sizes.lastCall.args[0].forceFresh).to.equal(true)
    clock.tick(2000)
    await runCheck(engine, job)
    expect(sizes.lastCall.args[0]).to.include({ maxAgeMs: 2000, forceFresh: true })
    engine.serviceDiskSamples.set(job.serviceId, {
      containerId: job.containerId,
      usedBytes: 8 * GiB,
      at: Date.now(),
      growthBytesPerSecond: 4 * GiB,
      intervalMs: 2000
    })
    sizes.resolves(new Map([['models', 8 * GiB]]))
    clock.tick(2000)
    await runCheck(engine, job)
    expect(sizes.lastCall.args[0]).to.include({ maxAgeMs: 2000, forceFresh: true })
  })

  it('shares node-wide measurement slots across engines without blocking launch', async () => {
    const releases: (() => void)[] = []
    let active = 0
    let peak = 0
    const engines = Array.from({ length: 4 }, (_, i) => {
      const job = { ...makeJob(), serviceId: `limited-${i}` }
      const inspect = sinon.stub().callsFake(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active--
        return { State: { Running: true }, SizeRw: 0 }
      })
      const engine = makeEngine(job, inspect)
      if (i === 3) {
        engine.serviceDiskSamples.set(job.serviceId, {
          containerId: job.containerId,
          usedBytes: 18 * GiB,
          at: Date.now() - 2000,
          growthBytesPerSecond: 0,
          intervalMs: 2000
        })
      }
      return { engine, job, inspect }
    })
    for (const { engine, job } of engines)
      expect(engine.launchServiceDiskCheck(job)).to.equal(undefined)
    await flush()
    expect(active).to.equal(2)
    expect(engines.map(({ inspect }) => inspect.callCount)).to.deep.equal([1, 0, 0, 1])
    releases.splice(0).forEach((release) => release())
    await flush()
    expect(active).to.equal(2)
    releases.splice(0).forEach((release) => release())
    await Promise.all(
      engines.flatMap(({ engine }) => [...engine.serviceDiskChecksInFlight.values()])
    )
    expect(peak).to.equal(2)
    expect(active).to.equal(0)
  })

  it('prioritises higher usage, preserves FIFO ties, and ages low-usage work fairly', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const schedule = createServiceDiskMeasurementQueue(1)
    const order: string[] = []
    let release: () => void
    const blocker = schedule(
      1,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await flush()
    const low = schedule(0, () => {
      order.push('old-low')
      return Promise.resolve()
    })
    clock.tick(SERVICE_DISK_QUEUE_AGING_MS + 1)
    const mid = schedule(0.5, () => {
      order.push('mid')
      return Promise.resolve()
    })
    const high = schedule(0.9, () => {
      order.push('high-first')
      return Promise.resolve()
    })
    const high2 = schedule(0.9, () => {
      order.push('high-second')
      return Promise.resolve()
    })
    release()
    await Promise.all([blocker, low, mid, high, high2])
    expect(order).to.deep.equal(['old-low', 'high-first', 'high-second', 'mid'])
  })

  it('releases measurement slots on rejection and skips queued work after shutdown', async () => {
    const schedule = createServiceDiskMeasurementQueue(1)
    const failure = schedule(0, () => Promise.reject(new Error('scan failed'))).catch(
      (e) => e.message
    )
    const next = schedule(0, () => Promise.resolve('next'))
    expect(await failure).to.equal('scan failed')
    expect(await next).to.equal('next')
    const job = makeJob()
    const engine = makeEngine(job)
    engine.launchServiceDiskCheck(job)
    engine.stopped = true
    await Promise.all([...engine.serviceDiskChecksInFlight.values()])
    expect(engine.docker.getContainer.called).to.equal(false)
  })

  it('expires completed df at the caller interval and refreshes newly discovered pressure', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const dial = sinon
      .stub()
      .yields(null, { Volumes: [{ Name: 'models', UsageData: { Size: 18 * GiB } }] })
    const sizes = createVolumeSizeCache({ modem: { dial } } as any)
    await sizes({ maxAgeMs: 2000 })
    clock.tick(1999)
    await sizes({ maxAgeMs: 2000 })
    expect(dial.calledOnce).to.equal(true)
    clock.tick(1)
    await sizes({ maxAgeMs: 2000 })
    expect(dial.calledTwice).to.equal(true)
    clock.tick(1)
    dial.yields(null, { Volumes: [{ Name: 'models', UsageData: { Size: 21 * GiB } }] })
    const inspect = sinon
      .stub()
      .resolves({ State: { Running: true }, SizeRw: 0, Mounts: [volumeMount] })
    const result = await measureServiceDiskUsage({ inspect } as any, makeJob(), sizes, {
      maxAgeMs: 2000
    })
    expect(result.usedBytes).to.equal(21 * GiB)
    expect(dial.calledThrice).to.equal(true)
  })

  it('keeps df single-flight after TTL expiry and across Docker clients for one daemon', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const dial = sinon.stub()
    const socketPath = `/test-df-${Date.now()}`
    const first = createVolumeSizeCache({ modem: { dial, socketPath } } as any, 1000)
    const otherDial = sinon.stub()
    const second = createVolumeSizeCache(
      { modem: { dial: otherDial, socketPath } } as any,
      1000
    )
    const requestedAt = Date.now()
    const pending = first({ forceFresh: true })
    await flush()
    clock.tick(30_000)
    const shared = second({ forceFresh: true, maxAgeMs: 1, freshAfter: requestedAt })
    await flush()
    expect(dial.calledOnce).to.equal(true)
    expect(otherDial.called).to.equal(false)
    dial.firstCall.args[1](null, { Volumes: [] })
    const [a, b] = await Promise.all([pending, shared])
    expect(a).to.equal(b)
    // Age starts when the scan starts, not when a slow scan finishes.
    otherDial.yields(null, { Volumes: [] })
    await second({ maxAgeMs: 1000 })
    expect(otherDial.calledOnce).to.equal(true)
  })

  it('serialises df requests even for different daemons', async () => {
    const firstDial = sinon.stub()
    const secondDial = sinon.stub().yields(null, { Volumes: [] })
    const first = createVolumeSizeCache({ modem: { dial: firstDial } } as any)
    const second = createVolumeSizeCache({ modem: { dial: secondDial } } as any)
    const p1 = first({ forceFresh: true })
    const p2 = second({ forceFresh: true })
    await flush()
    expect(firstDial.calledOnce).to.equal(true)
    expect(secondDial.called).to.equal(false)
    firstDial.firstCall.args[1](null, { Volumes: [] })
    await Promise.all([p1, p2])
    expect(secondDial.calledOnce).to.equal(true)
  })

  it('a forced caller never takes a df requested before it needed fresh data', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const dial = sinon.stub()
    const sizes = createVolumeSizeCache({ modem: { dial } } as any)
    const old = sizes()
    await flush()
    clock.tick(5)
    // Growth after the old scan began: the forced caller must wait it out and rescan.
    const forced = sizes({ forceFresh: true })
    await flush()
    expect(dial.calledOnce).to.equal(true)
    dial.firstCall.args[1](null, { Volumes: [{ Name: 'v', UsageData: { Size: 1 } }] })
    expect((await old).get('v')).to.equal(1)
    await flush()
    expect(dial.calledTwice).to.equal(true)
    dial.secondCall.args[1](null, { Volumes: [{ Name: 'v', UsageData: { Size: 9 } }] })
    expect((await forced).get('v')).to.equal(9)
    // A failed old scan is not served to the forced caller either, and is not cached.
    clock.tick(5)
    const failing = sizes({ forceFresh: true })
    await flush()
    clock.tick(5)
    const after = sizes({ forceFresh: true })
    await flush()
    dial.thirdCall.args[1](new Error('df timed out'))
    let failure: string
    await failing.catch((e) => {
      failure = e.message
    })
    expect(failure).to.equal('df timed out')
    await flush()
    expect(dial.callCount).to.equal(4)
    dial.lastCall.args[1](null, { Volumes: [{ Name: 'v', UsageData: { Size: 11 } }] })
    expect((await after).get('v')).to.equal(11)
  })

  it('services checked in one tick share one forced df instead of one each', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const dial = sinon
      .stub()
      .yields(null, { Volumes: [{ Name: 'v', UsageData: { Size: 1 } }] })
    const sizes = createVolumeSizeCache({ modem: { dial } } as any)
    const dueAt = Date.now()
    clock.tick(300)
    await sizes({ forceFresh: true, freshAfter: dueAt, maxAgeMs: 2000 })
    clock.tick(300)
    await sizes({ forceFresh: true, freshAfter: dueAt, maxAgeMs: 2000 })
    expect(dial.calledOnce).to.equal(true)
    // Data requested before the check fell due is never fresh enough.
    clock.tick(1)
    await sizes({ forceFresh: true, freshAfter: Date.now(), maxAgeMs: 2000 })
    expect(dial.calledTwice).to.equal(true)
    // A wall clock stepped back makes a cached entry look young: it is not fresh.
    clock.setSystemTime(Date.now() - 60_000)
    await sizes({ maxAgeMs: 2000 })
    expect(dial.calledThrice).to.equal(true)
  })

  it('waiting for a slow df holds no measurement slot', async () => {
    const dial = sinon.stub()
    const volumeJobs = [0, 1].map((i) => {
      const job = { ...makeJob(), serviceId: `df-wait-${i}` }
      const inspect = sinon
        .stub()
        .resolves({ State: { Running: true }, SizeRw: 0, Mounts: [volumeMount] })
      const engine = makeEngine(job, inspect)
      engine.docker.modem.dial = dial
      return { engine, job }
    })
    const shared = createVolumeSizeCache({ modem: { dial } } as any)
    for (const { engine } of volumeJobs) engine.serviceVolumeSizes = shared
    const plainJob = { ...makeJob(), serviceId: 'df-wait-plain' }
    const plainInspect = sinon.stub().resolves({ State: { Running: true }, SizeRw: 0 })
    const plain = makeEngine(plainJob, plainInspect)
    for (const { engine, job } of volumeJobs) engine.launchServiceDiskCheck(job)
    await flush()
    await flush()
    expect(dial.calledOnce).to.equal(true)
    plain.launchServiceDiskCheck(plainJob)
    await Promise.all([...plain.serviceDiskChecksInFlight.values()])
    expect(plainInspect.calledOnce).to.equal(true)
    dial.firstCall.args[1](null, {
      Volumes: [{ Name: 'models', UsageData: { Size: 1 } }]
    })
    await Promise.all(
      volumeJobs.flatMap(({ engine }) => [...engine.serviceDiskChecksInFlight.values()])
    )
    expect(dial.calledOnce).to.equal(true)
  })

  it('backs off failing scans and keeps near-quota usage when a sized mount drops out', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    sinon.stub(Math, 'random').returns(0)
    const job = makeJob()
    const inspect = sinon.stub().rejects(new Error('inspect timed out'))
    const engine = makeEngine(job, inspect)
    sinon.stub(CORE_LOGGER, 'warn')
    const near = {
      containerId: job.containerId,
      usedBytes: 17 * GiB,
      at: Date.now(),
      growthBytesPerSecond: 0,
      intervalMs: 2000,
      unmeasured: [] as string[]
    }
    engine.serviceDiskSamples.set(job.serviceId, near)
    const intervals: number[] = []
    for (let i = 0; i < 5; i++) {
      clock.tick(30_000)
      await runCheck(engine, job)
      const sample = engine.serviceDiskSamples.get(job.serviceId)
      expect(sample.usedBytes).to.equal(near.usedBytes)
      intervals.push(sample.intervalMs)
    }
    expect(intervals).to.deep.equal([4000, 8000, 16_000, 30_000, 30_000])
    expect(serviceDiskBackoffIntervalMs(2000)).to.equal(4000)

    // The volume used to be sized; a failed df now reports it unmeasured. That lower
    // bound must not demote a near-quota service to the coarse cadence.
    inspect.resolves({ State: { Running: true }, SizeRw: 0, Mounts: [volumeMount] })
    engine.serviceVolumeSizes = sinon.stub().rejects(new Error('df timed out'))
    engine.serviceDiskSamples.set(job.serviceId, { ...near, at: Date.now() })
    clock.tick(2000)
    await runCheck(engine, job)
    let sample = engine.serviceDiskSamples.get(job.serviceId)
    expect(sample.usedBytes).to.equal(near.usedBytes)
    expect(sample.intervalMs).to.equal(4000)
    expect(engine.doStopService.called).to.equal(false)
    // A lasting failure becomes the baseline once backed off to the coarse interval.
    for (let i = 0; i < 4; i++) {
      clock.tick(30_000)
      await runCheck(engine, job)
    }
    sample = engine.serviceDiskSamples.get(job.serviceId)
    expect(sample.usedBytes).to.equal(0)
    expect(sample.unmeasured).to.deep.equal(['volume models'])
    // Recovery: the next complete sample is used as-is.
    engine.serviceVolumeSizes = sinon.stub().resolves(new Map([['models', 5 * GiB]]))
    clock.tick(30_000)
    await runCheck(engine, job)
    sample = engine.serviceDiskSamples.get(job.serviceId)
    expect(sample.usedBytes).to.equal(5 * GiB)
    expect(sample.unmeasured).to.deep.equal([])
  })

  it('a wall clock stepped back does not suppress checks', async () => {
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const job = makeJob()
    const inspect = sinon.stub().resolves({ State: { Running: true }, SizeRw: 0 })
    const engine = makeEngine(job, inspect)
    await runCheck(engine, job)
    clock.setSystemTime(Date.now() - 3600_000)
    await runCheck(engine, job)
    expect(inspect.calledTwice).to.equal(true)
  })
})
