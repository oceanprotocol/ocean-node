import { expect, assert } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceStatusNumber, ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'

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
    getExpiredServiceJobs: sinon.stub().resolves([])
  }
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

  it('restartService holds the lock while the image pull is pending and releases it after', async () => {
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

    const restart = engine.restartService(SERVICE_ID, OWNER)
    await flush()
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(true)

    resolvePull!()
    const restarted = await restart
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
    expect(restarted.status).to.equal(ServiceStatusNumber.Running)
    expect(restarted.containerId).to.equal('newc')
  })

  it('restartService releases the lock on the failure path too', async () => {
    const engine = makeEngine()
    engine.db.getServiceJob.resolves([makeJob()])
    engine.docker.getContainer.returns(stubContainer())
    engine.pullImageRef = sinon.stub().rejects(new Error('pull failed'))

    try {
      await engine.restartService(SERVICE_ID, OWNER)
      expect.fail('expected restartService to reject')
    } catch (e: any) {
      expect(e.message).to.equal('pull failed')
    }
    expect(engine.serviceOpsInFlight.has(SERVICE_ID)).to.equal(false)
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
})
