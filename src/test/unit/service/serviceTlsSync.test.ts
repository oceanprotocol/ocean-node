import { expect } from 'chai'
import sinon from 'sinon'
import http from 'http'
import os from 'os'
import path from 'path'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { C2DClusterType } from '../../../@types/C2D/C2D.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import { buildCaddyServers } from '../../../components/c2d/serviceTls.js'
import { caddyPost } from '../../../components/c2d/caddyAdmin.js'
import { releaseHostPort } from '../../../components/core/service/utils.js'

const NODE_HOST = '157.66.255.31'
const SERVERS_PATH = '/config/apps/http/servers'
let socketCount = 0

interface FakeCaddy {
  socketPath: string
  requests: { method: string; url: string; body: any }[]
  status: number
  close: () => Promise<void>
}

// Stands in for Caddy's admin API on a unix socket
async function fakeCaddy(): Promise<FakeCaddy> {
  const socketPath = path.join(os.tmpdir(), `caddy-${process.pid}-${socketCount++}.sock`)
  const fake: FakeCaddy = { socketPath, requests: [], status: 200, close: null }
  const server = http.createServer((req, res) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => {
      fake.requests.push({
        method: req.method,
        url: req.url,
        body: text ? JSON.parse(text) : undefined
      })
      res.writeHead(fake.status)
      res.end(fake.status < 300 ? '{}' : '{"error":"boom"}')
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  fake.close = () => new Promise((resolve) => server.close(() => resolve()))
  return fake
}

describe('caddyPost', () => {
  let caddy: FakeCaddy
  beforeEach(async () => {
    caddy = await fakeCaddy()
  })
  afterEach(() => caddy.close())

  it('POSTs the JSON over the socket', async () => {
    await caddyPost(SERVERS_PATH, '{"a":1}', caddy.socketPath)
    expect(caddy.requests).to.deep.equal([
      { method: 'POST', url: SERVERS_PATH, body: { a: 1 } }
    ])
  })

  it('throws on a non-2xx answer, without the request body', async () => {
    caddy.status = 400
    let error: Error
    try {
      await caddyPost(SERVERS_PATH, '{"a":1}', caddy.socketPath)
    } catch (e) {
      error = e
    }
    expect(error.message).to.equal(
      `caddy admin POST ${SERVERS_PATH}: 400 {"error":"boom"}`
    )
  })

  it('throws when the socket is missing', async () => {
    let error: Error
    try {
      await caddyPost(SERVERS_PATH, '{}', caddy.socketPath + '.missing')
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(Error)
  })
})

describe('service TLS sync (Caddy admin API)', () => {
  let engine: any
  let network: any
  let caddy: FakeCaddy
  let containers: Record<string, any>

  // the first socketPath Docker cluster is the TLS engine
  function setTlsEngine(opts: {
    nodeHost?: string
    socketPath?: string
    first?: string
  }) {
    engine.getC2DConfig = sinon.stub().returns({
      hash: 'cluster-hash',
      connection: {
        socketPath: opts.socketPath ?? '/var/run/docker.sock',
        serviceOnDemand: {
          hostPortRange: [31042, 31141],
          nodeHost: opts.nodeHost ?? NODE_HOST
        }
      }
    })
    engine.getConfig = sinon.stub().returns({
      c2dClusters: [
        { type: C2DClusterType.OPF_K8, hash: 'k8s', connection: {} },
        {
          type: C2DClusterType.DOCKER,
          hash: opts.first ?? 'cluster-hash',
          connection: { socketPath: '/var/run/docker.sock' }
        }
      ]
    })
  }

  function inspectWithIp(serviceId: string, ip: string) {
    return sinon.stub().resolves({
      NetworkSettings: { Networks: { [`ocean-svc-${serviceId}`]: { IPAddress: ip } } }
    })
  }

  beforeEach(async () => {
    caddy = await fakeCaddy()
    engine = Object.create(C2DEngineDocker.prototype)
    engine.caddySocket = caddy.socketPath
    engine.tlsSync = Promise.resolve()
    engine.caddyLastPost = null
    engine.lastTlsSyncOk = false
    engine.caddyIps = new Map()
    engine.cpuAllocations = new Map()
    engine.envCpuCoresMap = new Map()
    engine.serviceOpsInFlight = new Set()
    engine.serviceOpPromises = new Set()
    network = {
      id: 'net-1',
      inspect: sinon.stub().resolves({ Containers: {} }),
      remove: sinon.stub().resolves()
    }
    containers = {}
    const service = {
      id: 'svc-container',
      start: sinon.stub().resolves(),
      stop: sinon.stub().resolves(),
      remove: sinon.stub().resolves(),
      infoArchive: sinon.stub().resolves({}),
      inspect: inspectWithIp('x', '172.20.0.2')
    }
    containers['svc-container'] = service
    engine.docker = {
      createNetwork: sinon.stub().resolves(network),
      createContainer: sinon.stub().resolves(service),
      getNetwork: sinon.stub().returns(network),
      getContainer: sinon.stub().callsFake((id: string) => containers[id])
    }
    engine.db = {
      updateServiceJob: sinon.stub().resolves(),
      acquireServiceLock: sinon.stub().resolves(true),
      releaseServiceLock: sinon.stub().resolves(undefined),
      getRunningServiceJobs: sinon.stub().resolves([])
    }
    setTlsEngine({})
    engine.pullImageRef = sinon.stub().resolves()
    engine.buildServiceResourceConstraints = sinon
      .stub()
      .returns({ Memory: 0, NanoCpus: 0, DeviceRequests: [] })
    engine.escrow = {
      createLock: sinon.stub().resolves('0xlock'),
      waitForTransaction: sinon.stub().resolves(),
      claimLock: sinon.stub().resolves('0xclaim'),
      cancelExpiredLock: sinon.stub().resolves('0xcancel'),
      getMinLockTime: sinon.stub().returns(3600)
    }
    engine.keyManager = { decrypt: sinon.stub().resolves(Buffer.from('{}')) }
  })

  afterEach(async () => {
    sinon.restore()
    await caddy.close()
    // claimed services keep their host ports reserved: free them for the next test
    for (let p = 31042; p <= 31141; p++) releaseHostPort(p)
  })

  function makeStartingJob(overrides: any = {}) {
    return {
      serviceId: 'x',
      clusterHash: 'cluster-hash',
      environment: 'env-1',
      owner: '0xowner',
      image: 'nginx',
      tag: 'latest',
      containerImage: 'nginx:latest',
      containerId: '',
      networkId: '',
      status: ServiceStatusNumber.Starting,
      statusText: 'Starting',
      dateCreated: new Date().toISOString(),
      expiresAt: Date.now() + 60000,
      duration: 60,
      exposedPorts: [8188, 8189],
      endpoints: [] as any[],
      secureTls: [8188],
      resources: [{ id: 'cpu', amount: 1 }],
      payment: {
        chainId: 1,
        token: '0xtoken',
        cost: 10,
        lockTx: '',
        claimTx: '',
        cancelTx: ''
      },
      ...overrides
    }
  }

  function makeRunningJob(overrides: any = {}) {
    return {
      ...makeStartingJob(),
      status: ServiceStatusNumber.Running,
      statusText: 'Running',
      containerId: 'svc-container',
      endpoints: [
        {
          containerPort: 8188,
          hostPort: 31042,
          url: `https://${NODE_HOST}:31042`,
          tls: true
        },
        {
          containerPort: 8189,
          hostPort: 31043,
          url: `http://${NODE_HOST}:31043`,
          tls: false
        }
      ],
      payment: { chainId: 1, token: '0xtoken', claimTx: '0xclaim' },
      ...overrides
    }
  }

  const posts = () =>
    caddy.requests.filter((r) => r.method === 'POST' && r.url === SERVERS_PATH)

  describe('syncServiceTls', () => {
    it('POSTs one server map built from the running secure services', async () => {
      const a = makeRunningJob({ serviceId: 'a', containerId: 'ca' })
      containers.ca = { inspect: inspectWithIp('a', '172.20.0.5') }
      engine.db.getRunningServiceJobs.resolves([
        a,
        makeRunningJob({ serviceId: 'b', containerId: 'cb', secureTls: undefined }),
        makeStartingJob({ serviceId: 'c' })
      ])

      await engine.syncServiceTls()

      expect(posts()).to.have.length(1)
      expect(posts()[0].body).to.deep.equal(
        buildCaddyServers(NODE_HOST, [
          {
            serviceId: 'a',
            upstreamIp: '172.20.0.5',
            secureTls: a.secureTls,
            endpoints: a.endpoints
          }
        ])
      )
    })

    it('skips a service whose container cannot be inspected, and syncs the rest', async () => {
      containers.ca = { inspect: sinon.stub().rejects(new Error('no such container')) }
      containers.cb = { inspect: inspectWithIp('b', '172.20.0.6') }
      engine.db.getRunningServiceJobs.resolves([
        makeRunningJob({ serviceId: 'a', containerId: 'ca' }),
        makeRunningJob({ serviceId: 'b', containerId: 'cb' })
      ])

      await engine.syncServiceTls()

      expect(Object.keys(posts()[0].body)).to.deep.equal(['ocean_b_8188'])
    })

    for (const [name, opts] of [
      ['not the first socketPath engine', { first: 'other-hash' }],
      ['a remote daemon', { socketPath: '' }],
      ['a private nodeHost', { nodeHost: '192.168.1.10' }]
    ] as const) {
      it(`does nothing on ${name}`, async () => {
        setTlsEngine(opts)
        await engine.syncServiceTls()
        expect(caddy.requests).to.deep.equal([])
        expect(engine.db.getRunningServiceJobs.called).to.equal(false)
      })
    }

    it('a failed POST does not throw', async () => {
      caddy.status = 500
      engine.db.getRunningServiceJobs.resolves([makeRunningJob()])
      await engine.syncServiceTls()
      expect(posts()).to.have.length(1)
    })

    it('skips identical servers within a minute, re-sends them after', async () => {
      engine.db.getRunningServiceJobs.resolves([makeRunningJob()])
      await engine.syncServiceTls()
      await engine.syncServiceTls()
      expect(posts()).to.have.length(1)
      engine.caddyLastPost.at -= 60_000
      await engine.syncServiceTls()
      expect(posts()).to.have.length(2)
    })

    it('POSTs at once when the servers change', async () => {
      const job = makeRunningJob()
      engine.db.getRunningServiceJobs.resolves([job])
      await engine.syncServiceTls()
      engine.db.getRunningServiceJobs.resolves([])
      await engine.syncServiceTls()
      expect(posts().map((p) => Object.keys(p.body))).to.deep.equal([
        ['ocean_x_8188'],
        []
      ])
    })

    it('inspects a container only once while it runs', async () => {
      const job = makeRunningJob()
      engine.db.getRunningServiceJobs.resolves([job])
      await engine.syncServiceTls()
      engine.caddyLastPost.at -= 60_000
      await engine.syncServiceTls()
      expect(containers['svc-container'].inspect.calledOnce).to.equal(true)
    })
  })

  it('start: binds only the plain port on the service', async () => {
    const job = makeStartingJob()
    engine.db.getServiceJob = sinon.stub().resolves([job])

    await engine.processServiceStart(job)

    expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
    const secure = job.endpoints.find((e: any) => e.containerPort === 8188)
    expect(secure).to.include({
      tls: true,
      url: `https://${NODE_HOST}:${secure.hostPort}`
    })
    const opts = engine.docker.createContainer.firstCall.args[0]
    expect(Object.keys(opts.HostConfig.PortBindings)).to.deep.equal(['8189/tcp'])
    expect(Object.keys(opts.ExposedPorts)).to.have.members(['8188/tcp', '8189/tcp'])
    expect(engine.docker.createContainer.calledOnce).to.equal(true)
  })

  it('start without secureTls: every port bound on the service', async () => {
    const job = makeStartingJob({ secureTls: undefined })
    engine.db.getServiceJob = sinon.stub().resolves([job])

    await engine.processServiceStart(job)

    expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
    const opts = engine.docker.createContainer.firstCall.args[0]
    expect(Object.keys(opts.HostConfig.PortBindings)).to.have.members([
      '8188/tcp',
      '8189/tcp'
    ])
    expect(job.endpoints.every((e: any) => e.url.startsWith('http://'))).to.equal(true)
  })

  it('restart with []: Caddy drops the port before the service publishes it', async () => {
    const job = makeRunningJob()
    engine.db.getServiceJob = sinon.stub().resolves([job])
    engine.db.getRunningServiceJobs.callsFake(() => Promise.resolve([job]))
    const service = await engine.docker.createContainer()
    engine.docker.createContainer.resetHistory()
    let bodiesAtCreate: any[] = []
    engine.docker.createContainer.callsFake(() => {
      bodiesAtCreate = posts().map((p) => p.body)
      return Promise.resolve(service)
    })
    const args = [job.serviceId, '0xowner', ...Array(9).fill(undefined), []]

    await engine.restartService(...args)
    await Promise.allSettled([...engine.serviceOpPromises])

    expect(job.status, job.statusText).to.equal(ServiceStatusNumber.Running)
    expect(
      engine.docker.createContainer.firstCall.args[0].HostConfig.PortBindings
    ).to.deep.equal({
      '8188/tcp': [{ HostPort: '31042' }],
      '8189/tcp': [{ HostPort: '31043' }]
    })
    expect(bodiesAtCreate).to.deep.equal([{}])
  })

  describe('getComputeEnvironments features.secureTls', () => {
    async function feature() {
      engine.envs = [{ id: 'env-1', resources: [], free: { resources: [] } }]
      engine.getUsedResources = sinon.stub().resolves({
        totalJobs: 0,
        totalFreeJobs: 0,
        usedResources: {},
        usedFreeResources: {}
      })
      const [env] = await engine.getComputeEnvironments()
      return env.features.secureTls
    }

    it('is off until Caddy accepts a sync, and off again after a rejected one', async () => {
      expect(await feature()).to.equal(false)
      await engine.syncServiceTls()
      expect(await feature()).to.equal(true)
      caddy.status = 400
      engine.caddyLastPost.at -= 60_000
      await engine.syncServiceTls()
      expect(await feature()).to.equal(false)
    })

    it('is off on a non-TLS engine, even after a good sync', async () => {
      await engine.syncServiceTls()
      setTlsEngine({ first: 'other-hash' })
      expect(await feature()).to.equal(false)
      setTlsEngine({ nodeHost: 'localhost' })
      expect(await feature()).to.equal(false)
    })
  })
})
