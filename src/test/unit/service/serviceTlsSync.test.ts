import { expect } from 'chai'
import sinon from 'sinon'
import { C2DEngineDocker } from '../../../components/c2d/compute_engine_docker.js'
import { ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import {
  CaddyProxy,
  CADDY_ACME_JSON,
  CADDY_CONTAINER,
  CADDY_IMAGE,
  CADDY_LOAD_CMD,
  buildCaddyConfig,
  buildCaddyServers,
  ensureCaddy
} from '../../../components/c2d/caddyProxy.js'
import { releaseHostPort } from '../../../components/core/service/utils.js'

const NODE_HOST = '157.66.255.31'
const ACME_FILE = '/srv/letsencrypt/acme.json'

interface FakeCaddy {
  loads: any[] // configs Caddy accepted
  execs: { cmd: string[]; input: string }[]
  fail: boolean
  acmeJson: string
  hasCert: boolean // Caddy's storage holds a cert for nodeHost
}

// Stands in for the node's Caddy container (ensureCaddy + docker exec)
function fakeCaddyIo(fake: FakeCaddy) {
  const container = { id: 'caddy' }
  return {
    ensure: sinon.stub().resolves(container),
    remove: sinon.stub().resolves(),
    exec: sinon.stub().callsFake((_c: unknown, cmd: string[], input = '') => {
      fake.execs.push({ cmd, input })
      if (cmd === CADDY_LOAD_CMD) {
        if (fake.fail) return Promise.reject(new Error('caddy exec wget exited 1'))
        fake.loads.push(JSON.parse(input))
      }
      if (cmd[2]?.startsWith('ls ') && !fake.hasCert)
        return Promise.reject(new Error('caddy exec sh exited 1'))
      return Promise.resolve(cmd[0] === 'cat' ? fake.acmeJson : '')
    })
  }
}

function acmeJsonFor(name: string, sans: string[] = []): string {
  const b64 = (text: string) => Buffer.from(text).toString('base64')
  return JSON.stringify({
    myresolver: {
      Certificates: [
        {
          domain: { main: name, sans },
          certificate: b64('-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----\n'),
          key: b64('-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n')
        }
      ]
    }
  })
}

describe('ensureCaddy', () => {
  const BINDS = ['ocean-node-caddy-data:/data']
  function fakeDocker(info: any) {
    const existing = {
      inspect: info
        ? sinon.stub().resolves(info)
        : sinon.stub().rejects(Object.assign(new Error('gone'), { statusCode: 404 })),
      start: sinon.stub().resolves(),
      remove: sinon.stub().resolves()
    }
    const created = { start: sinon.stub().resolves() }
    return {
      existing,
      created,
      getContainer: sinon.stub().returns(existing),
      getImage: sinon.stub().returns({ inspect: sinon.stub().resolves({}) }),
      createContainer: sinon.stub().resolves(created)
    }
  }
  const LABEL = 'ocean-node.letsencrypt-acme-path'
  const OWNER = 'ocean-node.owner'
  const running = (acme = '', Image = CADDY_IMAGE, owner = '0xnode') => ({
    Config: { Image, Labels: { [LABEL]: acme, [OWNER]: owner } },
    State: { Running: true }
  })

  it('creates and starts Caddy on the host network when it is missing', async () => {
    const docker = fakeDocker(null)
    expect(await ensureCaddy(docker as any, '0xnode')).to.equal(docker.created)
    expect(docker.createContainer.firstCall.args[0]).to.deep.equal({
      name: CADDY_CONTAINER,
      Image: CADDY_IMAGE,
      Cmd: ['caddy', 'run'],
      Labels: { [LABEL]: '', [OWNER]: '0xnode' },
      HostConfig: { NetworkMode: 'host', RestartPolicy: { Name: 'always' }, Binds: BINDS }
    })
    expect(docker.created.start.calledOnce).to.equal(true)
  })

  it('keeps a running Caddy with the same image and files', async () => {
    const docker = fakeDocker(running())
    expect(await ensureCaddy(docker as any, '0xnode')).to.equal(docker.existing)
    expect(docker.existing.start.called).to.equal(false)
    expect(docker.createContainer.called).to.equal(false)
  })

  it("leaves another node's Caddy alone", async () => {
    const docker = fakeDocker(running('', CADDY_IMAGE, '0xother'))
    let error: Error
    await ensureCaddy(docker as any, '0xnode').catch((e) => (error = e))
    expect(error.message).to.contain('belongs to another node (0xother)')
    expect(docker.existing.remove.called).to.equal(false)
  })

  it('recreates Caddy when the image or the letsEncryptAcmePath changes', async () => {
    for (const [info, acme] of [
      [running('', 'caddy:2.10.0-alpine'), undefined],
      [running(), '/srv/letsencrypt/acme.json']
    ] as const) {
      const docker = fakeDocker(info)
      await ensureCaddy(docker as any, '0xnode', acme)
      expect(docker.existing.remove.calledOnce).to.equal(true)
      expect(docker.createContainer.calledOnce).to.equal(true)
    }
    const docker = fakeDocker(null)
    await ensureCaddy(docker as any, '0xnode', '/srv/letsencrypt/acme.json')
    expect(docker.createContainer.firstCall.args[0].HostConfig.Binds).to.deep.equal([
      ...BINDS,
      `/srv/letsencrypt/acme.json:${CADDY_ACME_JSON}:ro`
    ])
  })
})

describe('service TLS sync (Caddy admin API)', () => {
  let engine: any
  let network: any
  let caddy: FakeCaddy
  let io: ReturnType<typeof fakeCaddyIo>
  let containers: Record<string, any>

  function setTlsEngine(opts: { nodeHost?: string; letsEncryptAcmePath?: string }) {
    engine.getC2DConfig = sinon.stub().returns({
      hash: 'cluster-hash',
      connection: {
        socketPath: '/var/run/docker.sock',
        serviceOnDemand: {
          hostPortRange: [31042, 31141],
          nodeHost: opts.nodeHost ?? NODE_HOST,
          letsEncryptAcmePath: opts.letsEncryptAcmePath
        }
      }
    })
  }

  function inspectWithIp(serviceId: string, ip: string) {
    return sinon.stub().resolves({
      NetworkSettings: { Networks: { [`ocean-svc-${serviceId}`]: { IPAddress: ip } } }
    })
  }

  beforeEach(() => {
    caddy = { loads: [], execs: [], fail: false, acmeJson: '{}', hasCert: true }
    engine = Object.create(C2DEngineDocker.prototype)
    engine.tlsSync = Promise.resolve(true)
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
    io = fakeCaddyIo(caddy)
    engine.caddy = new CaddyProxy(engine.docker, '0xnode', io as any)
  })

  afterEach(() => {
    sinon.restore()
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

  const posts = () => caddy.loads.map((config) => ({ body: config.apps.http.servers }))

  describe('syncServiceTls', () => {
    it('loads one server map built from the running secure services', async () => {
      const a = makeRunningJob({ serviceId: 'a', containerId: 'ca' })
      containers.ca = { inspect: inspectWithIp('a', '172.20.0.5') }
      engine.db.getRunningServiceJobs.resolves([
        a,
        makeRunningJob({ serviceId: 'b', containerId: 'cb', secureTls: undefined }),
        makeStartingJob({ serviceId: 'c' })
      ])

      await engine.syncServiceTls()

      expect(caddy.loads).to.deep.equal([
        buildCaddyConfig(
          buildCaddyServers(NODE_HOST, [
            {
              serviceId: 'a',
              upstreamIp: '172.20.0.5',
              endpoints: a.endpoints
            }
          ]),
          NODE_HOST
        )
      ])
      expect(io.ensure.firstCall.args.slice(1)).to.deep.equal(['0xnode', undefined])
    })

    it('a failed load does not throw, and is retried on the next sync', async () => {
      caddy.fail = true
      engine.db.getRunningServiceJobs.resolves([makeRunningJob()])
      await engine.syncServiceTls()
      caddy.fail = false
      await engine.syncServiceTls()
      expect(posts()).to.have.length(1)
    })

    it('letsEncryptAcmePath: loads its cert for nodeHost, no ACME, no port 80', async () => {
      setTlsEngine({ nodeHost: 'cp2.oncompute.ai', letsEncryptAcmePath: ACME_FILE })
      caddy.acmeJson = acmeJsonFor('1.c2d.nodes.oceanprotocol.com', ['cp2.oncompute.ai'])
      engine.db.getRunningServiceJobs.resolves([makeRunningJob()])

      await engine.syncServiceTls()

      expect(io.ensure.firstCall.args[2]).to.equal(ACME_FILE)
      const [read, write] = caddy.execs
      expect(read.cmd).to.deep.equal(['cat', CADDY_ACME_JSON])
      expect(write.input).to.equal(
        '-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----\n' +
          '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----'
      )
      const [config] = caddy.loads
      const file = config.apps.tls.certificates.load_files[0].certificate
      expect(write.cmd[2]).to.match(new RegExp(`cat > ${file}$`))
      expect(config.apps.tls).to.not.have.property('automation')
      expect(config.apps.http.servers.ocean_x_8188.automatic_https).to.deep.equal({
        disable_redirects: true
      })
      expect(engine.caddy.certReady).to.equal(true)
    })

    it('TLS off on the TLS engine: removes Caddy once, so it frees the ports', async () => {
      setTlsEngine({ nodeHost: 'localhost' })
      expect(await engine.syncServiceTls()).to.equal(true)
      await engine.syncServiceTls()
      expect(io.remove.calledOnceWith(engine.docker, '0xnode')).to.equal(true)
      expect(io.ensure.called).to.equal(false)
    })

    it('skips identical servers within a minute, re-sends them after', async () => {
      engine.db.getRunningServiceJobs.resolves([makeRunningJob()])
      await engine.syncServiceTls()
      await engine.syncServiceTls()
      expect(posts()).to.have.length(1)
      engine.caddy.lastLoad.at -= 60_000
      await engine.syncServiceTls()
      expect(posts()).to.have.length(2)
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

  it('restart with []: fails before publishing the port when Caddy does not free it', async () => {
    const job = makeRunningJob()
    engine.db.getServiceJob = sinon.stub().resolves([job])
    engine.db.getRunningServiceJobs.callsFake(() => Promise.resolve([job]))
    caddy.fail = true
    engine.docker.createContainer.resetHistory()
    const args = [job.serviceId, '0xowner', ...Array(9).fill(undefined), []]

    await engine.restartService(...args)
    await Promise.allSettled([...engine.serviceOpPromises])

    expect(job.status).to.equal(ServiceStatusNumber.Error)
    expect(job.statusText).to.contain('Caddy did not release the TLS ports')
    expect(engine.docker.createContainer.called).to.equal(false)
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

    it('is off until Caddy holds the certificate', async () => {
      caddy.hasCert = false
      await engine.syncServiceTls()
      expect(caddy.loads).to.have.length(1)
      expect(await feature()).to.equal(false)
      caddy.hasCert = true
      engine.caddy.lastLoad.at -= 60_000
      await engine.syncServiceTls()
      expect(await feature()).to.equal(true)
    })

    it('is off until Caddy accepts a sync, and off again after a rejected one', async () => {
      expect(await feature()).to.equal(false)
      await engine.syncServiceTls()
      expect(await feature()).to.equal(true)
      caddy.fail = true
      engine.caddy.lastLoad.at -= 60_000
      await engine.syncServiceTls()
      expect(await feature()).to.equal(false)
    })
  })
})
