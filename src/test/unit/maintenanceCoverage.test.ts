import { expect } from 'chai'
import sinon from 'sinon'
import { Readable } from 'stream'
import { OceanNode } from '../../OceanNode.js'
import { Database } from '../../components/database/index.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { BlockchainRegistry } from '../../components/BlockchainRegistry/index.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'
import {
  MAINTENANCE_MODE_CODE,
  MAINTENANCE_MODE_CONFIG_KEY,
  PROTOCOL_COMMANDS,
  SERVICES_API_BASE_PATH
} from '../../utils/constants.js'
import {
  DetailedStatusHandler,
  StatusHandler
} from '../../components/core/handler/statusHandler.js'
import { directCommandRoute } from '../../components/httpRoutes/commands.js'
import { computeRoutes } from '../../components/httpRoutes/compute.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'

/**
 * QA coverage-gap tests for maintenance mode (self-contained: no Barge). Complements
 * maintenanceMode.test.ts / maintenanceRoutes.test.ts, which call handlers directly and stub
 * the handler behind the REST routes. Here we go through the REAL dispatch path
 * (OceanNode.handleDirectProtocolCommand -> CoreHandlersRegistry), the real /directCommand
 * route, the real REST routes (no handler stub), the P2P status-frame serialization, the
 * env-boot matrix, a genuinely new OceanNode instance reloading from the DB, and a
 * differential "allowed commands behave identically on/off" check.
 */

const CONSUMER = '0x0000000000000000000000000000000000000001'
const PAYMENT = { chainId: 8996, token: '0x0000000000000000000000000000000000000002' }

async function bodyOf(resp: P2PCommandResponse): Promise<any> {
  if (!resp.stream) return null
  let out = ''
  for await (const chunk of resp.stream as Readable) out += chunk.toString()
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

// the 5 commands that must be blocked, with minimal params that pass validate()
const BLOCKED: Array<{ name: string; task: any }> = [
  {
    name: 'startCompute',
    task: {
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      environment: '0xhash-env',
      algorithm: {},
      datasets: [],
      maxJobDuration: 100,
      consumerAddress: CONSUMER
    }
  },
  {
    name: 'freeStartCompute',
    task: {
      command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      environment: '0xhash-env',
      algorithm: {},
      datasets: [],
      consumerAddress: CONSUMER
    }
  },
  {
    name: 'initializeCompute',
    task: {
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE,
      environment: '0xhash-env',
      algorithm: {},
      datasets: [],
      payment: PAYMENT,
      consumerAddress: CONSUMER
    }
  },
  {
    name: 'serviceStart',
    task: {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      environment: 'env',
      image: 'ubuntu',
      duration: 100,
      payment: PAYMENT,
      consumerAddress: CONSUMER
    }
  },
  {
    name: 'serviceExtend',
    task: {
      command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
      serviceId: 'svc-1',
      additionalDuration: 100,
      payment: PAYMENT,
      consumerAddress: CONSUMER
    }
  }
]

// commands that must NOT be affected. Params are whatever each validate() needs; the
// handlers are expected to fail later (bad signature / no engine) -- the assertion is that
// the outcome is IDENTICAL with maintenance on and off.
const ALLOWED: Array<{ name: string; task: any }> = [
  [PROTOCOL_COMMANDS.COMPUTE_GET_STATUS, { consumerAddress: CONSUMER, jobId: 'j1' }],
  [
    PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
    { consumerAddress: CONSUMER, jobId: 'j1', index: 0, nonce: '1', signature: '0xsig' }
  ],
  [
    PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS,
    { consumerAddress: CONSUMER, jobId: 'j1', nonce: '1', signature: '0xsig' }
  ],
  [
    PROTOCOL_COMMANDS.COMPUTE_STOP,
    { consumerAddress: CONSUMER, jobId: 'j1', nonce: '1', signature: '0xsig' }
  ],
  [PROTOCOL_COMMANDS.SERVICE_GET_STATUS, { consumerAddress: CONSUMER, serviceId: 's1' }],
  [
    PROTOCOL_COMMANDS.SERVICE_GET_RESULT,
    { consumerAddress: CONSUMER, serviceId: 's1', nonce: '1', signature: '0xsig' }
  ],
  [
    PROTOCOL_COMMANDS.SERVICE_STOP,
    { consumerAddress: CONSUMER, serviceId: 's1', nonce: '1', signature: '0xsig' }
  ],
  [
    PROTOCOL_COMMANDS.SERVICE_GET_STREAMABLE_LOGS,
    { consumerAddress: CONSUMER, serviceId: 's1', nonce: '1', signature: '0xsig' }
  ],
  [
    PROTOCOL_COMMANDS.SERVICE_RESTART,
    { consumerAddress: CONSUMER, serviceId: 's1', nonce: '1', signature: '0xsig' }
  ],
  [PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS, {}],
  [PROTOCOL_COMMANDS.JOBS, {}],
  [PROTOCOL_COMMANDS.NONCE, { address: CONSUMER }],
  [PROTOCOL_COMMANDS.STATUS, {}],
  [PROTOCOL_COMMANDS.DETAILED_STATUS, { detailed: true }]
].map(([command, rest]: any) => ({ name: command, task: { command, ...rest } }))

function fakeRes() {
  const res: any = {
    statusCode: 200,
    chunks: [] as string[],
    headers: {} as any,
    ended: false
  }
  res.status = (c: number) => {
    res.statusCode = c
    return res
  }
  res.header = (h: any) => Object.assign(res.headers, h)
  res.write = (d: any) => {
    res.chunks.push(d.toString())
    return true
  }
  res.send = (d: any) => {
    res.chunks.push(typeof d === 'string' ? d : JSON.stringify(d))
    return res
  }
  res.json = (d: any) => {
    res.body = d
    return res
  }
  res.set = () => res
  res.on = () => res
  res.end = () => {
    res.ended = true
    return res
  }
  return res
}

function routeHandler(router: any, method: string, p: string) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === p && l.route.methods[method]
  )
  if (!layer) throw new Error(`route ${method} ${p} not found`)
  // last handler in the stack (directCommand has express.json() first)
  const { stack } = layer.route
  return stack[stack.length - 1].handle
}

describe('Maintenance mode - QA coverage gaps', () => {
  let envOverrides: OverrideEnvConfig[]
  let oceanNode: OceanNode
  let db: Database
  let config: any
  let keyManager: KeyManager
  let blockchainRegistry: BlockchainRegistry

  const buildNode = () =>
    OceanNode.getInstance(
      config,
      db,
      undefined,
      undefined,
      undefined,
      keyManager,
      blockchainRegistry,
      true
    )

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [
        ENVIRONMENT_VARIABLES.PRIVATE_KEY,
        ENVIRONMENT_VARIABLES.MAINTENANCE_MODE,
        ENVIRONMENT_VARIABLES.RPCS
      ],
      [
        '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
        '',
        '{ "8996": "http://127.0.0.1:8545" }'
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    db = await Database.init({ url: 'http://localhost:9999', dbType: 'none' } as any)
    keyManager = new KeyManager(config)
    blockchainRegistry = new BlockchainRegistry(keyManager, config)
    oceanNode = buildNode()
    await oceanNode.setMaintenanceMode(false)
  })

  afterEach(async () => {
    sinon.restore()
    await oceanNode.setMaintenanceMode(false)
  })

  after(async () => {
    await oceanNode.setMaintenanceMode(false)
    await tearDownEnvironment(envOverrides)
  })

  // ---------------------------------------------------------------- transports
  describe('real dispatch (OceanNode.handleDirectProtocolCommand) + P2P status frame', () => {
    for (const { name, task } of BLOCKED) {
      it(`${name}: 503 + code via real dispatch; code survives JSON.stringify(status) (P2P frame)`, async () => {
        await oceanNode.setMaintenanceMode(true)
        const resp = await oceanNode.handleDirectProtocolCommand(JSON.stringify(task))
        expect(resp.status.httpStatus).to.equal(503)
        // What handleProtocolCommands writes to the wire: JSON.stringify(response.status)
        const wire = JSON.parse(JSON.stringify(resp.status))
        expect(wire.code).to.equal(MAINTENANCE_MODE_CODE)
        expect(wire.httpStatus).to.equal(503)
        expect((await bodyOf(resp)).code).to.equal(MAINTENANCE_MODE_CODE)
      })

      it(`${name}: toggle OFF re-allows it (no maintenance code)`, async () => {
        await oceanNode.setMaintenanceMode(true)
        await oceanNode.setMaintenanceMode(false)
        const resp = await oceanNode.handleDirectProtocolCommand(JSON.stringify(task))
        expect(resp.status.code).to.not.equal(MAINTENANCE_MODE_CODE)
      })
    }
  })

  describe('real /directCommand express route', () => {
    for (const { name, task } of BLOCKED) {
      it(`${name}: HTTP 503 and body {error, code}`, async () => {
        await oceanNode.setMaintenanceMode(true)
        const req: any = { body: task, oceanNode, headers: {}, caller: '127.0.0.1' }
        const res = fakeRes()
        await routeHandler(directCommandRoute, 'post', '/directCommand')(req, res)
        expect(res.statusCode).to.equal(503)
        const parsed = JSON.parse(res.chunks.join(''))
        expect(parsed.code).to.equal(MAINTENANCE_MODE_CODE)
        expect(parsed.error).to.be.a('string')
      })
    }
  })

  describe('real REST routes (handler NOT stubbed)', () => {
    const routes = [
      {
        name: 'computeStart',
        p: `${SERVICES_API_BASE_PATH}/compute`,
        body: BLOCKED[0].task
      },
      {
        name: 'freeCompute',
        p: `${SERVICES_API_BASE_PATH}/freeCompute`,
        body: BLOCKED[1].task
      },
      {
        name: 'initializeCompute',
        p: `${SERVICES_API_BASE_PATH}/initializeCompute`,
        body: BLOCKED[2].task
      },
      {
        name: 'serviceStart',
        p: `${SERVICES_API_BASE_PATH}/serviceStart`,
        body: BLOCKED[3].task
      },
      {
        name: 'serviceExtend',
        p: `${SERVICES_API_BASE_PATH}/serviceExtend`,
        body: BLOCKED[4].task
      }
    ]
    for (const r of routes) {
      it(`${r.name}: 503 + code end-to-end through the real handler`, async () => {
        await oceanNode.setMaintenanceMode(true)
        const req: any = {
          query: {},
          headers: {},
          body: { ...r.body },
          oceanNode,
          caller: '127.0.0.1'
        }
        const res = fakeRes()
        res.req = req
        await routeHandler(computeRoutes, 'post', r.p)(req, res)
        expect(res.statusCode).to.equal(503)
        expect(res.body).to.be.an('object')
        expect(res.body.code).to.equal(MAINTENANCE_MODE_CODE)
      })
    }

    it('DISTINCT signal: pre-existing 503 "Compute engines not configured" carries NO code', async () => {
      // maintenance OFF, no C2D engines on this node -> serviceStart's pre-existing 503
      await oceanNode.setMaintenanceMode(false)
      const req: any = {
        query: {},
        headers: {},
        body: { ...BLOCKED[3].task },
        oceanNode,
        caller: '127.0.0.1'
      }
      const res = fakeRes()
      res.req = req
      await routeHandler(
        computeRoutes,
        'post',
        `${SERVICES_API_BASE_PATH}/serviceStart`
      )(req, res)
      // clients must discriminate on `code`, not on the status
      const code = res.body?.code
      expect(code).to.not.equal(MAINTENANCE_MODE_CODE)
    })
  })

  // ---------------------------------------------------------------- allowed commands
  describe('ALLOWED commands behave identically with maintenance ON and OFF', () => {
    for (const { name, task } of ALLOWED) {
      it(`${name}`, async () => {
        await oceanNode.setMaintenanceMode(false)
        const off = await oceanNode.handleDirectProtocolCommand(JSON.stringify(task))
        await oceanNode.setMaintenanceMode(true)
        const on = await oceanNode.handleDirectProtocolCommand(JSON.stringify(task))
        expect(on.status.code).to.not.equal(MAINTENANCE_MODE_CODE)
        // differential: same HTTP status and same error text => maintenance changed nothing
        expect(on.status.httpStatus).to.equal(off.status.httpStatus)
        expect(on.status.error).to.equal(off.status.error)
      })
    }
  })

  // ---------------------------------------------------------------- persistence / restart
  describe('restart / persistence', () => {
    it('a NEW OceanNode instance reads the persisted flag after loadMaintenanceMode()', async () => {
      await oceanNode.setMaintenanceMode(true)
      const fresh = buildNode()
      expect(fresh).to.not.equal(oceanNode)
      expect(fresh.isInMaintenance()).to.equal(false) // cache starts cold
      await fresh.loadMaintenanceMode()
      expect(fresh.isInMaintenance()).to.equal(true)
      const resp = await fresh.handleDirectProtocolCommand(
        JSON.stringify(BLOCKED[0].task)
      )
      expect(resp.status.code).to.equal(MAINTENANCE_MODE_CODE)
      await fresh.setMaintenanceMode(false)
      oceanNode = fresh
    })

    it('flag absent from DB -> loads OFF (fail-open)', async () => {
      await oceanNode.setMaintenanceMode(true)
      sinon.stub(db.sqliteConfig, 'retrieveValue').resolves({ value: null } as any)
      await oceanNode.loadMaintenanceMode()
      expect(oceanNode.isInMaintenance()).to.equal(false)
    })

    it('no sqliteConfig: toggle works in-memory only and does not throw', async () => {
      const real = db.sqliteConfig
      ;(db as any).sqliteConfig = undefined
      try {
        await oceanNode.setMaintenanceMode(true)
        expect(oceanNode.isInMaintenance()).to.equal(true)
        // load with no DB must neither throw nor clobber the in-memory value
        await oceanNode.loadMaintenanceMode()
        expect(oceanNode.isInMaintenance()).to.equal(true)
      } finally {
        ;(db as any).sqliteConfig = real
      }
    })

    it('concurrent toggles are serialized: DB and cache end in agreement', async () => {
      await Promise.all([
        oceanNode.setMaintenanceMode(true),
        oceanNode.setMaintenanceMode(false),
        oceanNode.setMaintenanceMode(true),
        oceanNode.setMaintenanceMode(false),
        oceanNode.setMaintenanceMode(true)
      ])
      const stored = await db.sqliteConfig.retrieveValue(MAINTENANCE_MODE_CONFIG_KEY)
      expect(oceanNode.isInMaintenance()).to.equal(stored.value === 'true')
      expect(oceanNode.isInMaintenance()).to.equal(true) // last call wins
    })

    it('a failed write does not poison the lock chain (next toggle still works)', async () => {
      const stub = sinon.stub(db.sqliteConfig, 'createOrUpdateConfig').resolves(null)
      let threw = false
      try {
        await oceanNode.setMaintenanceMode(true)
      } catch {
        threw = true
      }
      expect(threw).to.equal(true)
      stub.restore()
      await oceanNode.setMaintenanceMode(true)
      expect(oceanNode.isInMaintenance()).to.equal(true)
    })
  })

  // ---------------------------------------------------------------- env boot matrix
  describe('MAINTENANCE_MODE env boot matrix', () => {
    const setEnv = (v: string | undefined) => {
      if (v === undefined) delete process.env.MAINTENANCE_MODE
      else process.env.MAINTENANCE_MODE = v
    }
    afterEach(() => setEnv(undefined))

    const matrix: Array<{
      env: string | undefined
      persisted: boolean
      expected: boolean
      why: string
    }> = [
      { env: 'true', persisted: false, expected: true, why: 'env true boots into drain' },
      {
        env: 'false',
        persisted: true,
        expected: false,
        why: 'env false overrides persisted true'
      },
      {
        env: 'definitely-not-a-bool',
        persisted: false,
        expected: false,
        why: 'invalid ignored, persisted false wins'
      },
      {
        env: '1',
        persisted: true,
        expected: true,
        why: '"1" is NOT honored, persisted true wins (S4)'
      },
      { env: 'yes', persisted: true, expected: true, why: '"yes" not honored (S4)' },
      { env: '', persisted: true, expected: true, why: 'empty string = unset' },
      { env: undefined, persisted: true, expected: true, why: 'unset: persisted wins' },
      { env: undefined, persisted: false, expected: false, why: 'unset + not persisted' }
    ]
    for (const m of matrix) {
      it(`env=${JSON.stringify(m.env)} persisted=${m.persisted} -> ${m.expected} (${m.why})`, async () => {
        await oceanNode.setMaintenanceMode(m.persisted)
        ;(oceanNode as any).maintenanceMode = !m.expected // force a visible transition
        setEnv(m.env)
        await oceanNode.loadMaintenanceMode()
        expect(oceanNode.isInMaintenance()).to.equal(m.expected)
      })
    }

    it('env true/false is written through to the DB (sticky: survives next boot without env)', async () => {
      await oceanNode.setMaintenanceMode(false)
      setEnv('true')
      await oceanNode.loadMaintenanceMode()
      setEnv(undefined)
      ;(oceanNode as any).maintenanceMode = false
      await oceanNode.loadMaintenanceMode()
      expect(oceanNode.isInMaintenance()).to.equal(true)
    })

    it('env true with no sqliteConfig still boots into drain (process-only)', async () => {
      const real = db.sqliteConfig
      ;(db as any).sqliteConfig = undefined
      try {
        setEnv('true')
        await oceanNode.loadMaintenanceMode()
        expect(oceanNode.isInMaintenance()).to.equal(true)
      } finally {
        ;(db as any).sqliteConfig = real
      }
    })

    it('there is no TTL / auto-clear: flag still set after loads with no env', async () => {
      await oceanNode.setMaintenanceMode(true)
      for (let i = 0; i < 3; i++) await oceanNode.loadMaintenanceMode()
      expect(oceanNode.isInMaintenance()).to.equal(true)
    })
  })

  // ---------------------------------------------------------------- status
  describe('status.maintenance', () => {
    const statusOf = async (detailed: boolean) => {
      const handler = detailed
        ? new DetailedStatusHandler(oceanNode)
        : new StatusHandler(oceanNode)
      const resp = await handler.handle({
        command: detailed ? PROTOCOL_COMMANDS.DETAILED_STATUS : PROTOCOL_COMMANDS.STATUS
      } as any)
      return bodyOf(resp)
    }

    it('enabled is fresh per request (not stale from the module-level status cache)', async () => {
      await oceanNode.setMaintenanceMode(false)
      expect((await statusOf(true)).maintenance.enabled).to.equal(false)
      await oceanNode.setMaintenanceMode(true)
      expect((await statusOf(true)).maintenance.enabled).to.equal(true)
      await oceanNode.setMaintenanceMode(false)
      expect((await statusOf(true)).maintenance.enabled).to.equal(false)
    })

    it('a detailed call does not leave counts lingering on a following plain status call', async () => {
      await oceanNode.setMaintenanceMode(true)
      sinon
        .stub(db.c2d, 'getRunningJobs')
        .resolves([{ dateCreated: '1730000000', maxJobDuration: 10 }] as any)
      const detailed = await statusOf(true)
      expect(detailed.maintenance.runningComputeJobs).to.equal(1)
      const plain = await statusOf(false)
      expect(plain.maintenance.enabled).to.equal(true)
      expect(plain.maintenance).to.not.have.property('runningComputeJobs')
      expect(plain.maintenance).to.not.have.property('latestExpectedEndTime')
    })

    it('detailed status on a node without C2D engines does not throw and omits runningServices', async () => {
      await oceanNode.setMaintenanceMode(true)
      sinon.stub(db.c2d, 'getRunningJobs').resolves([])
      sinon.stub(oceanNode, 'getC2DEngines').returns(undefined as any)
      const s = await statusOf(true)
      expect(s.maintenance.enabled).to.equal(true)
      expect(s.maintenance.runningComputeJobs).to.equal(0)
      expect(s.maintenance).to.not.have.property('runningServices')
      expect(s.maintenance).to.not.have.property('latestExpectedEndTime')
    })

    it('a DB error computing counts does not break status (enabled still reported)', async () => {
      await oceanNode.setMaintenanceMode(true)
      sinon.stub(db.c2d, 'getRunningJobs').rejects(new Error('db down'))
      const s = await statusOf(true)
      expect(s.maintenance.enabled).to.equal(true)
    })

    it('ETA = max over compute jobs (start + maxJobDuration) AND service expiresAt (ms->s); counts services', async () => {
      await oceanNode.setMaintenanceMode(true)
      sinon.stub(db.c2d, 'getRunningJobs').resolves([
        { dateCreated: '1730000000', maxJobDuration: 100 }, // 1730000100
        { dateCreated: '1730000050.5', maxJobDuration: 500 }, // 1730000550.5
        { dateCreated: 'garbage', maxJobDuration: 500 } // NaN: must be ignored, still counted
      ] as any)
      const engine = {
        getC2DConfig: () => ({ hash: 'h1' }),
        db: {
          getRunningServiceJobs: () =>
            Promise.resolve([{ expiresAt: 1730009999000 }, { expiresAt: 1730000200000 }])
        }
      }
      sinon
        .stub(oceanNode, 'getC2DEngines')
        .returns({ getAllEngines: () => Promise.resolve([engine]) } as any)
      const s = await statusOf(true)
      expect(s.maintenance.runningComputeJobs).to.equal(3)
      expect(s.maintenance.runningServices).to.equal(2)
      expect(s.maintenance.latestExpectedEndTime).to.equal(1730009999)
    })

    it('non-finished-jobs count (S3): real c2d DB rows with dateFinished NULL are counted, finished are not', async () => {
      await oceanNode.setMaintenanceMode(true)
      const jobBase: any = {
        owner: CONSUMER,
        environment: 'env-qa',
        clusterHash: 'qa-cluster',
        algorithm: {},
        assets: [],
        isRunning: false,
        isStarted: false,
        stopRequested: false,
        maxJobDuration: 60,
        payment: null,
        resources: [],
        isFree: true,
        containerImage: 'x',
        metadata: {}
      }
      const ids = ['qa-job-pulling', 'qa-job-running', 'qa-job-done']
      const now = String(Date.now() / 1000)
      let baseline = -1
      try {
        baseline = (await db.c2d.getRunningJobs()).length
        await db.c2d.newJob({
          ...jobBase,
          jobId: ids[0],
          status: 10, // PullImage: not RunningAlgorithm, still not finished
          statusText: 'pulling',
          dateCreated: now,
          dateFinished: null
        })
        await db.c2d.newJob({
          ...jobBase,
          jobId: ids[1],
          status: 30,
          statusText: 'running',
          dateCreated: now,
          dateFinished: null
        })
        await db.c2d.newJob({
          ...jobBase,
          jobId: ids[2],
          status: 70,
          statusText: 'finished',
          dateCreated: now,
          dateFinished: null
        })
        // newJob does not write dateFinished; mark it finished the way the engine does
        await db.c2d.updateJob({
          ...jobBase,
          jobId: ids[2],
          status: 70,
          statusText: 'finished',
          dateCreated: now,
          dateFinished: now
        })
        const s = await statusOf(true)
        expect(s.maintenance.runningComputeJobs).to.equal(baseline + 2)
      } finally {
        for (const id of ids) await db.c2d.deleteJob(id).catch(() => false)
      }
    })
  })
})
