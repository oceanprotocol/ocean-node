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
  PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { SetMaintenanceHandler } from '../../components/core/admin/setMaintenanceHandler.js'
import { DetailedStatusHandler } from '../../components/core/handler/statusHandler.js'
import {
  PaidComputeStartHandler,
  FreeComputeStartHandler,
  ComputeInitializeHandler,
  ComputeStopHandler
} from '../../components/core/compute/index.js'
import {
  ServiceStartHandler,
  ServiceExtendHandler,
  ServiceStopHandler,
  ServiceRestartHandler
} from '../../components/core/service/index.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'

const CONSUMER = '0x0000000000000000000000000000000000000001'
const PAYMENT = { chainId: 8996, token: '0x0000000000000000000000000000000000000002' }

async function streamBody(resp: P2PCommandResponse): Promise<any> {
  if (!resp.stream) return null
  let out = ''
  for await (const chunk of resp.stream as Readable) {
    out += chunk.toString()
  }
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

describe('Maintenance mode', () => {
  let envOverrides: OverrideEnvConfig[]
  let oceanNode: OceanNode
  let db: Database

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
    // Make sure no stale env leaks the flag into loadMaintenanceMode
    delete process.env.MAINTENANCE_MODE
    const config = await getConfiguration(true)
    // SQLite-core-only DB: an invalid dbType skips the metadata DB (no Typesense/ES needed)
    // while nonce/config/c2d/auth SQLite databases are always created.
    db = await Database.init({ url: 'http://localhost:9999', dbType: 'none' } as any)
    const keyManager = new KeyManager(config)
    const blockchainRegistry = new BlockchainRegistry(keyManager, config)
    oceanNode = OceanNode.getInstance(
      config,
      db,
      undefined,
      undefined,
      undefined,
      keyManager,
      blockchainRegistry,
      true
    )
    // Start from a clean, known state.
    await oceanNode.setMaintenanceMode(false)
  })

  after(async () => {
    await oceanNode.setMaintenanceMode(false)
    await tearDownEnvironment(envOverrides)
  })

  it('OceanNode caches, persists and reloads the flag', async () => {
    expect(oceanNode.isInMaintenance()).to.equal(false)

    await oceanNode.setMaintenanceMode(true)
    expect(oceanNode.isInMaintenance()).to.equal(true)
    const stored = await db.sqliteConfig.retrieveValue(MAINTENANCE_MODE_CONFIG_KEY)
    expect(stored.value).to.equal('true')

    // Simulate a restart: wipe the in-memory cache then reload from the persisted DB value.
    ;(oceanNode as any).maintenanceMode = false
    await oceanNode.loadMaintenanceMode()
    expect(oceanNode.isInMaintenance()).to.equal(true)

    await oceanNode.setMaintenanceMode(false)
    expect(oceanNode.isInMaintenance()).to.equal(false)
    const stored2 = await db.sqliteConfig.retrieveValue(MAINTENANCE_MODE_CONFIG_KEY)
    expect(stored2.value).to.equal('false')
  })

  it('SetMaintenanceHandler.validate rejects a non-boolean enabled', async () => {
    const handler = new SetMaintenanceHandler(oceanNode)
    const result = await handler.validate({
      command: PROTOCOL_COMMANDS.SET_MAINTENANCE,
      enabled: 'yes' as any,
      nonce: '1',
      address: CONSUMER,
      signature: '0xsig'
    })
    expect(result.valid).to.equal(false)
  })

  it('SetMaintenanceHandler requires a valid admin signature', async () => {
    // Fake node whose auth rejects: validate must fail and the state must not change.
    const fakeNode = {
      getAuth: () => ({
        validateAuthenticationOrToken: () =>
          Promise.resolve({ valid: false, error: 'bad signature' })
      }),
      getAdminAddresses: () => ({
        addresses: [] as string[],
        accessLists: undefined as any
      })
    } as unknown as OceanNode
    const handler = new SetMaintenanceHandler(fakeNode)
    const result = await handler.validate({
      command: PROTOCOL_COMMANDS.SET_MAINTENANCE,
      enabled: true,
      nonce: '1',
      address: CONSUMER,
      signature: '0xsig'
    })
    expect(result.valid).to.equal(false)
  })

  it('SetMaintenanceHandler flips OceanNode state and persists when authorized', async () => {
    // Bypass admin-auth (covered above) to exercise handle() -> state -> DB wiring.
    class TestHandler extends SetMaintenanceHandler {
      validate() {
        return Promise.resolve({ valid: true })
      }
    }
    const handler = new TestHandler(oceanNode)
    const resp = await handler.handle({
      command: PROTOCOL_COMMANDS.SET_MAINTENANCE,
      enabled: true,
      nonce: '1',
      address: CONSUMER,
      signature: '0xsig',
      caller: undefined
    } as any)
    expect(resp.status.httpStatus).to.equal(200)
    expect(await streamBody(resp)).to.deep.equal({ maintenance: true })
    expect(oceanNode.isInMaintenance()).to.equal(true)
    const stored = await db.sqliteConfig.retrieveValue(MAINTENANCE_MODE_CONFIG_KEY)
    expect(stored.value).to.equal('true')
    await oceanNode.setMaintenanceMode(false)
  })

  it('does NOT update the cache (and the handler returns 500) when the DB write fails', async () => {
    await oceanNode.setMaintenanceMode(false)
    const stub = sinon.stub(db.sqliteConfig, 'createOrUpdateConfig').resolves(null)
    try {
      let threw = false
      try {
        await oceanNode.setMaintenanceMode(true)
      } catch {
        threw = true
      }
      expect(threw).to.equal(true)
      // Cache must NOT have flipped: the node must not claim an un-persisted drain.
      expect(oceanNode.isInMaintenance()).to.equal(false)

      // The admin handler must surface a 500, not a false success.
      class TestHandler extends SetMaintenanceHandler {
        validate() {
          return Promise.resolve({ valid: true })
        }
      }
      const resp = await new TestHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.SET_MAINTENANCE,
        enabled: true,
        nonce: '1',
        address: CONSUMER,
        signature: '0xsig'
      } as any)
      expect(resp.status.httpStatus).to.equal(500)
      expect(oceanNode.isInMaintenance()).to.equal(false)
    } finally {
      stub.restore()
    }
  })

  it('status latestExpectedEndTime includes compute jobs (decimal-seconds dateCreated)', async () => {
    await oceanNode.setMaintenanceMode(true)
    // getRunningJobs is what the status handler counts; stub it with a decimal-seconds
    // dateCreated (Date.parse would be NaN and silently drop it from the ETA).
    const stub = sinon
      .stub(db.c2d, 'getRunningJobs')
      .resolves([{ dateCreated: '1730000000.5', maxJobDuration: 3600 }] as any)
    try {
      const resp = await new DetailedStatusHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.DETAILED_STATUS
      } as any)
      const status = await streamBody(resp)
      expect(status.maintenance.runningComputeJobs).to.equal(1)
      expect(status.maintenance.latestExpectedEndTime).to.equal(1730003600.5)
    } finally {
      stub.restore()
      await oceanNode.setMaintenanceMode(false)
    }
  })

  it('loadMaintenanceMode ignores an invalid MAINTENANCE_MODE env value', async () => {
    await oceanNode.setMaintenanceMode(true)
    process.env.MAINTENANCE_MODE = 'definitely-not-a-bool'
    try {
      await oceanNode.loadMaintenanceMode()
      // invalid value is ignored -> falls back to the persisted flag (true)
      expect(oceanNode.isInMaintenance()).to.equal(true)
    } finally {
      delete process.env.MAINTENANCE_MODE
      await oceanNode.setMaintenanceMode(false)
    }
  })

  describe('guarded handlers reject with 503 + MAINTENANCE_MODE when draining', () => {
    const cases: Array<{ name: string; handler: () => any; task: any }> = [
      {
        name: 'startCompute',
        handler: () => new PaidComputeStartHandler(oceanNode),
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
        handler: () => new FreeComputeStartHandler(oceanNode),
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
        handler: () => new ComputeInitializeHandler(oceanNode),
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
        handler: () => new ServiceStartHandler(oceanNode),
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
        handler: () => new ServiceExtendHandler(oceanNode),
        task: {
          command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
          serviceId: 'svc-1',
          additionalDuration: 100,
          payment: PAYMENT,
          consumerAddress: CONSUMER
        }
      }
    ]

    beforeEach(async () => {
      await oceanNode.setMaintenanceMode(true)
    })
    afterEach(async () => {
      await oceanNode.setMaintenanceMode(false)
    })

    cases.forEach(({ name, handler, task }) => {
      it(`${name} returns 503 + code while in maintenance`, async () => {
        const resp = await handler().handle(task)
        expect(resp.status.httpStatus).to.equal(503)
        expect(resp.status.code).to.equal(MAINTENANCE_MODE_CODE)
        const body = await streamBody(resp)
        expect(body.code).to.equal(MAINTENANCE_MODE_CODE)
      })

      it(`${name} is NOT rejected with maintenance code when not in maintenance`, async () => {
        await oceanNode.setMaintenanceMode(false)
        const resp = await handler().handle(task)
        // It may fail later for other reasons (no engine/chain), but never with the
        // maintenance code.
        expect(resp.status.code).to.not.equal(MAINTENANCE_MODE_CODE)
      })
    })
  })

  describe('non-guarded handlers are unaffected by maintenance', () => {
    beforeEach(async () => {
      await oceanNode.setMaintenanceMode(true)
    })
    afterEach(async () => {
      await oceanNode.setMaintenanceMode(false)
    })

    const nonGuarded: Array<{ name: string; handler: () => any; task: any }> = [
      {
        name: 'stopCompute',
        handler: () => new ComputeStopHandler(oceanNode),
        task: {
          command: PROTOCOL_COMMANDS.COMPUTE_STOP,
          consumerAddress: CONSUMER,
          jobId: 'job-1',
          nonce: '1',
          signature: '0xsig'
        }
      },
      {
        name: 'serviceStop',
        handler: () => new ServiceStopHandler(oceanNode),
        task: {
          command: PROTOCOL_COMMANDS.SERVICE_STOP,
          consumerAddress: CONSUMER,
          serviceId: 'svc-1',
          nonce: '1',
          signature: '0xsig'
        }
      },
      {
        name: 'serviceRestart',
        handler: () => new ServiceRestartHandler(oceanNode),
        task: {
          command: PROTOCOL_COMMANDS.SERVICE_RESTART,
          consumerAddress: CONSUMER,
          serviceId: 'svc-1',
          nonce: '1',
          signature: '0xsig'
        }
      }
    ]

    nonGuarded.forEach(({ name, handler, task }) => {
      it(`${name} is never rejected with the maintenance code`, async () => {
        const resp = await handler().handle(task)
        expect(resp.status.code).to.not.equal(MAINTENANCE_MODE_CODE)
      })
    })
  })
})
