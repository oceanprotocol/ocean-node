import { expect } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceStatusNumber, ServiceJob } from '../../../@types/C2D/ServiceOnDemand.js'

const OWNER = '0x0000000000000000000000000000000000000001'
const SERVICE_ID = 'svc-1'
const NETWORK_NAME = `ocean-svc-${SERVICE_ID}`

function makeJob(overrides: Partial<ServiceJob> = {}): ServiceJob {
  return {
    serviceId: SERVICE_ID,
    clusterHash: 'hash-1',
    environment: 'env-1',
    owner: OWNER,
    image: 'img',
    tag: 'latest',
    containerImage: 'img:latest',
    containerId: 'c1',
    networkId: 'n1',
    status: ServiceStatusNumber.Running,
    statusText: 'Running',
    dateCreated: new Date(0).toISOString(),
    expiresAt: Date.now() + 3600_000,
    duration: 3600,
    exposedPorts: [8888],
    endpoints: [{ containerPort: 8888, hostPort: 31000, url: 'http://localhost:31000' }],
    userData: 'ENCRYPTED',
    resources: [{ id: 'cpu', amount: 2 }],
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

// Fake dockerode network handle: inspect() result (or rejection) and remove() behavior
// are configurable per test.
function fakeNetwork(opts: {
  inspect?: any
  inspectError?: any
  removeError?: any
}): any {
  return {
    inspect: opts.inspectError
      ? sinon.stub().rejects(opts.inspectError)
      : sinon.stub().resolves(opts.inspect ?? { Containers: {} }),
    remove: opts.removeError
      ? sinon.stub().rejects(opts.removeError)
      : sinon.stub().resolves(undefined)
  }
}

// Bypass the Docker-specific constructor while retaining the prototype chain (same
// pattern as compute.test.ts) so private methods can be exercised with a stubbed docker.
function makeEngine(): any {
  const engine: any = Object.create(C2DEngineDocker.prototype)
  engine.docker = {
    getNetwork: sinon.stub(),
    getContainer: sinon.stub(),
    createNetwork: sinon.stub()
  }
  engine.cpuAllocations = new Map()
  engine.serviceOpsInFlight = new Set()
  engine.serviceOpPromises = new Set()
  return engine
}

describe('service network cleanup (leaked ocean-svc-<id> networks)', () => {
  afterEach(() => sinon.restore())

  describe('removeServiceNetwork()', () => {
    it('removes the network by deterministic name when networkId is empty (leak scenario)', async () => {
      const engine = makeEngine()
      const network = fakeNetwork({})
      engine.docker.getNetwork.returns(network)

      await engine.removeServiceNetwork(SERVICE_ID)

      expect(engine.docker.getNetwork.calledOnceWith(NETWORK_NAME)).to.equal(true)
      expect(network.remove.calledOnce).to.equal(true)
    })

    it('tries both the persisted id and the deterministic name', async () => {
      const engine = makeEngine()
      const byName = fakeNetwork({})
      // after the first ref is removed, the second ref's inspect 404s and is skipped
      const byId = fakeNetwork({ inspectError: benignError(404) })
      engine.docker.getNetwork.withArgs(NETWORK_NAME).returns(byName)
      engine.docker.getNetwork.withArgs('n1').returns(byId)

      await engine.removeServiceNetwork(SERVICE_ID, 'n1')

      expect(engine.docker.getNetwork.calledWith(NETWORK_NAME)).to.equal(true)
      expect(engine.docker.getNetwork.calledWith('n1')).to.equal(true)
      expect(byName.remove.calledOnce).to.equal(true)
      expect(byId.remove.called).to.equal(false)
    })

    it('force-removes stale attached containers before removing the network', async () => {
      const engine = makeEngine()
      const network = fakeNetwork({ inspect: { Containers: { cid1: {}, cid2: {} } } })
      engine.docker.getNetwork.returns(network)
      const containerRemove = sinon.stub().resolves(undefined)
      engine.docker.getContainer.returns({ remove: containerRemove })

      await engine.removeServiceNetwork(SERVICE_ID)

      expect(engine.docker.getContainer.calledWith('cid1')).to.equal(true)
      expect(engine.docker.getContainer.calledWith('cid2')).to.equal(true)
      expect(containerRemove.alwaysCalledWith({ force: true })).to.equal(true)
      expect(network.remove.calledOnce).to.equal(true)
      expect(containerRemove.calledBefore(network.remove)).to.equal(true)
    })

    it('resolves silently when the network is already gone (404 inspect / 404 remove)', async () => {
      const engine = makeEngine()
      const gone = fakeNetwork({ inspectError: benignError(404) })
      engine.docker.getNetwork.returns(gone)
      await engine.removeServiceNetwork(SERVICE_ID)
      expect(gone.remove.called).to.equal(false)

      const goneOnRemove = fakeNetwork({ removeError: benignError(404) })
      engine.docker.getNetwork.returns(goneOnRemove)
      await engine.removeServiceNetwork(SERVICE_ID)
      expect(goneOnRemove.remove.calledOnce).to.equal(true)
    })

    it('propagates non-benign docker errors', async () => {
      const engine = makeEngine()
      engine.docker.getNetwork.returns(fakeNetwork({ inspectError: benignError(500) }))
      try {
        await engine.removeServiceNetwork(SERVICE_ID)
        expect.fail('expected removeServiceNetwork to reject')
      } catch (e: any) {
        expect(e.statusCode).to.equal(500)
      }

      engine.docker.getNetwork.returns(fakeNetwork({ removeError: benignError(500) }))
      try {
        await engine.removeServiceNetwork(SERVICE_ID)
        expect.fail('expected removeServiceNetwork to reject')
      } catch (e: any) {
        expect(e.statusCode).to.equal(500)
      }
    })
  })

  describe('createServiceNetwork()', () => {
    it('returns the created network on the happy path', async () => {
      const engine = makeEngine()
      const created = { id: 'newnet' }
      engine.docker.createNetwork.resolves(created)

      const result = await engine.createServiceNetwork(SERVICE_ID)

      expect(result).to.equal(created)
      expect(engine.docker.createNetwork.calledOnceWith({ Name: NETWORK_NAME })).to.equal(
        true
      )
    })

    it('on 409 removes the stale network and retries once (self-heal)', async () => {
      const engine = makeEngine()
      const created = { id: 'newnet' }
      engine.docker.createNetwork
        .onFirstCall()
        .rejects(benignError(409))
        .onSecondCall()
        .resolves(created)
      const stale = fakeNetwork({})
      engine.docker.getNetwork.returns(stale)

      const result = await engine.createServiceNetwork(SERVICE_ID)

      expect(result).to.equal(created)
      expect(stale.remove.calledOnce).to.equal(true)
      expect(engine.docker.createNetwork.calledTwice).to.equal(true)
    })

    it('does not retry on non-409 errors', async () => {
      const engine = makeEngine()
      engine.docker.createNetwork.rejects(benignError(500))

      try {
        await engine.createServiceNetwork(SERVICE_ID)
        expect.fail('expected createServiceNetwork to reject')
      } catch (e: any) {
        expect(e.statusCode).to.equal(500)
      }
      expect(engine.docker.createNetwork.calledOnce).to.equal(true)
      expect(engine.docker.getNetwork.called).to.equal(false)
    })
  })

  describe('stopService() with a leaked network (empty networkId)', () => {
    it('removes the network by deterministic name and ends Stopped', async () => {
      const engine = makeEngine()
      const job = makeJob({ containerId: '', networkId: '' })
      engine.db = {
        getServiceJob: sinon.stub().resolves([job]),
        updateServiceJob: sinon.stub().resolves(1)
      }
      const network = fakeNetwork({})
      engine.docker.getNetwork.returns(network)

      const result = await engine.stopService(SERVICE_ID, OWNER)

      expect(engine.docker.getNetwork.calledWith(NETWORK_NAME)).to.equal(true)
      expect(network.remove.calledOnce).to.equal(true)
      expect(result.status).to.equal(ServiceStatusNumber.Stopped)
    })
  })
})
