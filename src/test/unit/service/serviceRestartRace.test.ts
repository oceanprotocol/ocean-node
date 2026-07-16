import { expect, assert } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceStatusNumber, ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'
import {
  allocateHostPort,
  releaseHostPort,
  reserveHostPort
} from '../../../components/core/service/utils.js'

const OWNER = '0x0000000000000000000000000000000000000001'
const SERVICE_ID = 'svc-race-1'
const CLUSTER_HASH = 'hash-1'

// Flushes the microtask queue so an unawaited async call can progress through its
// (immediately-resolving) stubbed awaits up to the next genuinely pending promise.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
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
    exposedPorts: [8888],
    endpoints: [{ containerPort: 8888, hostPort: 31000, url: 'http://localhost:31000' }],
    userData: undefined, // decryptUserData(undefined) → {} — keyManager never touched
    resources: [], // no cpu request → allocateCpus is skipped
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

function benignError(statusCode: number = 404) {
  const e: any = new Error(`docker ${statusCode}`)
  e.statusCode = statusCode
  return e
}

// Bypass the Docker-specific constructor while retaining the prototype chain (same
// pattern as serviceNetworkCleanup.test.ts) so private methods/fields can be exercised
// with a stubbed docker + db.
function makeEngine(): any {
  const engine: any = Object.create(C2DEngineDocker.prototype)
  engine.docker = {
    getNetwork: sinon.stub(),
    getContainer: sinon.stub(),
    createNetwork: sinon.stub(),
    createContainer: sinon.stub()
  }
  // networks are "already gone" by default (benign 404 on inspect)
  engine.docker.getNetwork.returns({
    inspect: sinon.stub().rejects(benignError(404)),
    remove: sinon.stub().resolves(undefined)
  })
  engine.db = {
    getServiceJob: sinon.stub().resolves([]),
    updateServiceJob: sinon.stub().resolves(1),
    getRunningJobs: sinon.stub().resolves([]),
    getPendingServiceStarts: sinon.stub().resolves([]),
    getExpiredServiceJobs: sinon.stub().resolves([]),
    // cross-process lifecycle lease (service_locks table) — free by default
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
    connection: { resources: [], serviceOnDemand: {} }
  }
  engine.stopped = false
  engine.isInternalLoopRunning = false
  engine.cronTimer = null
  engine.setNewTimer = sinon.stub()
  engine.checkRunningServices = sinon.stub().resolves()
  return engine
}

function stubContainer(overrides: Record<string, any> = {}) {
  return {
    stop: sinon.stub().resolves(undefined),
    remove: sinon.stub().resolves(undefined),
    start: sinon.stub().resolves(undefined),
    ...overrides
  }
}

describe('service lifecycle lock (restart/stop vs InternalLoop races)', () => {
  afterEach(() => sinon.restore())

  it('restartService returns Restarting immediately and holds the lock until the background op settles', async () => {
    const engine = makeEngine()
    const job = makeJob()
    engine.db.getServiceJob.resolves([job])
    engine.docker.getContainer.returns(stubContainer())
    engine.docker.createNetwork.resolves({ id: 'newnet' })
    const newContainer = stubContainer()
    ;(newContainer as any).id = 'newc'
    engine.docker.createContainer.resolves(newContainer)
    let resolvePull: () => void
    engine.pullImageRef = () =>
      new Promise<void>((resolve) => {
        resolvePull = resolve
      })

    // Non-blocking: resolves as soon as the job is validated + persisted Restarting,
    // while the teardown/pull/start continue in the background under the lock.
    const snapshot = await engine.restartService(SERVICE_ID, OWNER)
    expect(snapshot.status).to.equal(ServiceStatusNumber.Restarting)
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(true)

    await flush() // let the background op reach the pending pull
    resolvePull!()
    await Promise.allSettled([...engine.serviceOpPromises])
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
    expect(job.status).to.equal(ServiceStatusNumber.Running)
    expect(job.containerId).to.equal('newc')
  })

  it('restartService releases the lock and persists Error on the failure path', async () => {
    const engine = makeEngine()
    const job = makeJob()
    engine.db.getServiceJob.resolves([job])
    engine.docker.getContainer.returns(stubContainer())
    engine.pullImageRef = sinon.stub().rejects(new Error('pull failed'))

    const snapshot = await engine.restartService(SERVICE_ID, OWNER)
    expect(snapshot.status).to.equal(ServiceStatusNumber.Restarting)
    await Promise.allSettled([...engine.serviceOpPromises])
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
    expect(job.status).to.equal(ServiceStatusNumber.Error)
    expect(job.statusText).to.equal('pull failed')
  })

  it('restartService rejects a service whose payment was refunded (never claimed)', async () => {
    const engine = makeEngine()
    engine.db.getServiceJob.resolves([
      makeJob({
        status: ServiceStatusNumber.Error,
        payment: {
          chainId: 8996,
          token: '0xtoken',
          lockTx: '0xl',
          claimTx: '',
          cancelTx: '0xcancel',
          cost: 5
        }
      })
    ])

    try {
      await engine.restartService(SERVICE_ID, OWNER)
      expect.fail('expected restartService to reject')
    } catch (e: any) {
      expect(e.message).to.contain('refunded')
    }
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
    expect(engine.docker.getContainer.called).to.equal(false)
  })

  it('restartService rejects a service that was never paid at all (escrow lock failed)', async () => {
    // The free-compute vector: start against an empty escrow account → createLock fails
    // → Error with ALL payment fields empty → a restart must not run the service anyway.
    const engine = makeEngine()
    engine.db.getServiceJob.resolves([
      makeJob({
        status: ServiceStatusNumber.Error,
        statusText: 'User 0x… does not have enough funds',
        payment: {
          chainId: 8996,
          token: '0xtoken',
          lockTx: '',
          claimTx: '',
          cancelTx: '',
          cost: 5
        }
      })
    ])

    try {
      await engine.restartService(SERVICE_ID, OWNER)
      expect.fail('expected restartService to reject')
    } catch (e: any) {
      expect(e.message).to.contain('never claimed')
    }
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
    expect(engine.docker.getContainer.called).to.equal(false)
    expect(engine.docker.createNetwork.called).to.equal(false)
  })

  it('rejects a concurrent restart/stop while the lock is held, without touching docker or the DB', async () => {
    const engine = makeEngine()
    engine.serviceOpsInFlight.add(SERVICE_ID)

    for (const call of [
      () => engine.restartService(SERVICE_ID, OWNER),
      () => engine.stopService(SERVICE_ID, OWNER)
    ]) {
      try {
        await call()
        expect.fail('expected the call to reject while the lock is held')
      } catch (e: any) {
        expect(e.message).to.contain('operation in progress')
      }
    }
    expect(engine.docker.getContainer.called).to.equal(false)
    expect(engine.docker.getNetwork.called).to.equal(false)
    expect(engine.db.getServiceJob.called).to.equal(false)
    expect(engine.db.updateServiceJob.called).to.equal(false)
    // a failed acquire must not clear a lock held by the in-flight operation
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(true)
  })

  it('stopService holds the lock while stopping (a mid-stop restart rejects) and releases it after', async () => {
    const engine = makeEngine()
    const job = makeJob()
    engine.db.getServiceJob.resolves([job])
    let resolveStop: () => void
    const pendingStop = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    engine.docker.getContainer.returns(stubContainer({ stop: () => pendingStop }))

    const stop = engine.stopService(SERVICE_ID, OWNER)
    await flush()
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(true)
    try {
      await engine.restartService(SERVICE_ID, OWNER)
      expect.fail('expected restartService to reject while a stop is in flight')
    } catch (e: any) {
      expect(e.message).to.contain('operation in progress')
    }

    resolveStop!()
    const stopped = await stop
    expect(stopped.status).to.equal(ServiceStatusNumber.Stopped)
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
  })

  it('InternalLoop does not launch processServiceStart for a locked service (the orphan-recovery race)', async () => {
    const engine = makeEngine()
    const midRestart = makeJob({
      status: ServiceStatusNumber.PullImage,
      statusText: 'PullImage'
    })
    engine.db.getPendingServiceStarts.resolves([midRestart])
    engine.processServiceStart = sinon.stub().resolves()

    // serviceId locked (restartService in flight) → the loop must skip it
    engine.serviceOpsInFlight.add(SERVICE_ID)
    await engine.InternalLoop()
    expect(engine.processServiceStart.called).to.equal(false)

    // control: with the lock free the loop DOES pick the job up (orphan recovery),
    // proving this test fails without the lock
    engine.serviceOpsInFlight.clear()
    engine.isInternalLoopRunning = false
    await engine.InternalLoop()
    await flush()
    expect(engine.processServiceStart.calledOnceWith(midRestart)).to.equal(true)
  })

  it('engine stop() drains an in-flight handler-driven stopService before returning', async () => {
    const engine = makeEngine()
    engine.db.getServiceJob.resolves([makeJob()])
    let resolveStop: () => void
    const pendingStop = new Promise<void>((resolve) => {
      resolveStop = resolve
    })
    engine.docker.getContainer.returns(stubContainer({ stop: () => pendingStop }))

    const serviceStop = engine.stopService(SERVICE_ID, OWNER)
    await flush()
    expect(engine.serviceOpPromises.size).to.equal(1)

    let drained = false
    const engineStop = engine.stop().then(() => {
      drained = true
    })
    await flush()
    expect(drained).to.equal(false) // must wait on the in-flight stopService

    resolveStop!()
    await engineStop
    expect(drained).to.equal(true)
    expect((await serviceStop).status).to.equal(ServiceStatusNumber.Stopped)
    expect(engine.serviceOpPromises.size).to.equal(0)
  })

  it('the expiry sweep defers a locked service instead of marking it Expired without teardown', async () => {
    const engine = makeEngine()
    const expired = makeJob({ expiresAt: Date.now() - 1000 })
    engine.db.getExpiredServiceJobs.resolves([expired])
    engine.db.getServiceJob.resolves([expired])
    engine.docker.getContainer.returns(stubContainer())

    // locked (e.g. a user restart is mid-pull) → nothing stopped, nothing persisted
    engine.serviceOpsInFlight.add(SERVICE_ID)
    await engine.InternalLoop()
    expect(engine.db.updateServiceJob.called).to.equal(false)
    expect(engine.docker.getContainer.called).to.equal(false)
    assert(expired.status === ServiceStatusNumber.Running, 'status must be untouched')

    // lock free → the sweep stops the service and marks it Expired
    engine.serviceOpsInFlight.clear()
    engine.isInternalLoopRunning = false
    await engine.InternalLoop()
    expect(expired.status).to.equal(ServiceStatusNumber.Expired)
  })

  it('restartService rejects when another process holds the DB lease', async () => {
    const engine = makeEngine()
    engine.db.acquireServiceLock = sinon.stub().resolves(false) // held elsewhere

    try {
      await engine.restartService(SERVICE_ID, OWNER)
      expect.fail('expected restartService to reject')
    } catch (e: any) {
      expect(e.message).to.contain('operation in progress')
    }
    // the in-memory reservation must be rolled back so a later acquire can succeed
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
    expect(engine.db.getServiceJob.called).to.equal(false)
  })

  it('InternalLoop skips a pending job whose DB lease is held by another process', async () => {
    const engine = makeEngine()
    engine.db.getPendingServiceStarts.resolves([
      makeJob({ status: ServiceStatusNumber.PullImage, statusText: 'PullImage' })
    ])
    engine.db.acquireServiceLock = sinon.stub().resolves(false)
    engine.processServiceStart = sinon.stub().resolves()

    await engine.InternalLoop()
    await flush()
    expect(engine.processServiceStart.called).to.equal(false)
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
  })

  it('restartService releases the DB lease once the operation settles', async () => {
    const engine = makeEngine()
    engine.db.getServiceJob.resolves([makeJob()])
    engine.docker.getContainer.returns(stubContainer())
    engine.docker.createNetwork.resolves({ id: 'newnet' })
    const newContainer = stubContainer()
    ;(newContainer as any).id = 'newc'
    engine.docker.createContainer.resolves(newContainer)
    engine.pullImageRef = sinon.stub().resolves()

    await engine.restartService(SERVICE_ID, OWNER)
    await Promise.allSettled([...engine.serviceOpPromises])
    expect(
      engine.db.releaseServiceLock.calledWith(SERVICE_ID, 'test-holder'),
      'DB lease must be released with the holder id'
    ).to.equal(true)
  })

  it('an explicit stop KEEPS the host ports reserved; only expiry releases them', async () => {
    // The user-B scenario: A reserves for 1h, starts, stops after 30min. B must NOT be
    // able to grab A's port/resources — A can restart anytime until expiresAt.
    const PORT = 31555
    const engine = makeEngine()
    const job = makeJob({
      endpoints: [
        { containerPort: 8888, hostPort: PORT, url: `http://localhost:${PORT}` }
      ]
    })
    engine.db.getServiceJob.resolves([job])
    engine.docker.getContainer.returns(stubContainer())
    reserveHostPort(PORT) // as the original start allocation did

    const stopped = await engine.stopService(SERVICE_ID, OWNER)
    expect(stopped.status).to.equal(ServiceStatusNumber.Stopped)
    // "user B": the allocator must refuse the stopped service's port
    let refused = false
    try {
      await allocateHostPort(PORT, PORT)
    } catch {
      refused = true
    }
    expect(refused, "a stopped service's port must stay reserved").to.equal(true)

    // past expiresAt the sweep flips it to Expired and releases the port
    job.expiresAt = Date.now() - 1000
    engine.db.getExpiredServiceJobs.resolves([job])
    engine.isInternalLoopRunning = false
    await engine.InternalLoop()
    expect(job.status).to.equal(ServiceStatusNumber.Expired)
    expect(await allocateHostPort(PORT, PORT)).to.equal(PORT)
    releaseHostPort(PORT) // tidy up the test's own allocation
  })

  it('the expiry sweep does NOT mark Expired while teardown fails (no resource leak), then retries', async () => {
    const engine = makeEngine()
    const expired = makeJob({ expiresAt: Date.now() - 1000 })
    engine.db.getExpiredServiceJobs.resolves([expired])
    engine.db.getServiceJob.resolves([expired])
    // teardown fails hard (docker daemon down — NOT a benign 404)
    engine.docker.getContainer.returns(
      stubContainer({ stop: sinon.stub().rejects(benignError(500)) })
    )

    await engine.InternalLoop()
    // Expired is terminal and never swept again — a failed stop must leave the job
    // OUT of Expired (as Error "stop failed") so the container/ports aren't leaked.
    expect(expired.status).to.not.equal(ServiceStatusNumber.Expired)
    expect(String(expired.statusText)).to.contain('stop failed')

    // docker recovers → the next tick completes the teardown and marks Expired
    engine.docker.getContainer.returns(stubContainer())
    engine.isInternalLoopRunning = false
    await engine.InternalLoop()
    expect(expired.status).to.equal(ServiceStatusNumber.Expired)
  })

  it('the expiry sweep flips a Stopped service past expiresAt to Expired without touching docker', async () => {
    const engine = makeEngine()
    const stopped = makeJob({
      status: ServiceStatusNumber.Stopped,
      statusText: 'Stopped',
      containerId: '',
      networkId: '',
      expiresAt: Date.now() - 1000
    })
    engine.db.getExpiredServiceJobs.resolves([stopped])
    engine.db.getServiceJob.resolves([stopped])

    await engine.InternalLoop()

    expect(stopped.status).to.equal(ServiceStatusNumber.Expired)
    // resources were already released at stop time — no docker teardown must happen
    expect(engine.docker.getContainer.called).to.equal(false)
  })

  it('processServiceStart ignores a stale pending snapshot (job already Running again)', async () => {
    const engine = makeEngine()
    // Snapshot captured while a restart was mid-pull...
    const staleSnapshot = makeJob({
      status: ServiceStatusNumber.PullImage,
      statusText: 'PullImage',
      containerId: '',
      networkId: ''
    })
    // ...but by the time the loop processes it, the restart finished: the fresh DB row
    // is Running with live docker refs. Pre-guard, orphan-recovery would tear that
    // container + network down and clobber the status with Error.
    engine.db.getServiceJob.resolves([
      makeJob({
        status: ServiceStatusNumber.Running,
        containerId: 'c-live',
        networkId: 'n-live'
      })
    ])

    await engine.processServiceStart(staleSnapshot)

    expect(engine.docker.getNetwork.called).to.equal(false)
    expect(engine.docker.getContainer.called).to.equal(false)
    expect(engine.db.updateServiceJob.called).to.equal(false)
  })

  it('a stopped engine refuses new lifecycle operations', async () => {
    const engine = makeEngine()
    engine.stopped = true

    try {
      await engine.restartService(SERVICE_ID, OWNER)
      expect.fail('expected restartService to reject')
    } catch (e: any) {
      expect(e.message).to.contain('stopped')
    }
    expect(engine.db.getServiceJob.called).to.equal(false)
    expect(engine.db.acquireServiceLock.called).to.equal(false)
  })
})
