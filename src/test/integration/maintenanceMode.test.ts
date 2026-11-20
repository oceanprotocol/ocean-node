import { expect } from 'chai'
import { Readable } from 'stream'
import { OceanNode } from '../../OceanNode.js'
import { Database } from '../../components/database/index.js'
import { KeyManager } from '../../components/KeyManager/index.js'
import { BlockchainRegistry } from '../../components/BlockchainRegistry/index.js'
import { ENVIRONMENT_VARIABLES, getConfiguration } from '../../utils/index.js'
import { MAINTENANCE_MODE_CODE, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import {
  PaidComputeStartHandler,
  ComputeInitializeHandler
} from '../../components/core/compute/index.js'
import {
  ServiceStartHandler,
  ServiceExtendHandler
} from '../../components/core/service/index.js'
import { DetailedStatusHandler } from '../../components/core/handler/statusHandler.js'
import { SetMaintenanceHandler } from '../../components/core/admin/setMaintenanceHandler.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { P2PCommandResponse } from '../../@types/OceanNode.js'

/**
 * Drain-scenario integration coverage that does NOT require Barge: the maintenance guards
 * short-circuit before any chain / Docker / escrow work, so this exercises the real handlers,
 * the real config-DB persistence and the real status handler end-to-end.
 *
 * NOT covered here (requires a running Barge chain + Docker): that a compute job / service
 * STARTED before enabling maintenance still returns status/results/logs and can be stopped.
 * That half of the acceptance scenario must be run against a live environment.
 */

const CONSUMER = '0x0000000000000000000000000000000000000001'
const PAYMENT = { chainId: 8996, token: '0x0000000000000000000000000000000000000002' }

async function body(resp: P2PCommandResponse): Promise<any> {
  if (!resp.stream) return null
  let out = ''
  for await (const chunk of resp.stream as Readable) out += chunk.toString()
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

describe('Maintenance mode drain scenario (integration)', () => {
  let envOverrides: OverrideEnvConfig[]
  let oceanNode: OceanNode
  let db: Database

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.PRIVATE_KEY, ENVIRONMENT_VARIABLES.MAINTENANCE_MODE],
      ['0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58', '']
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    delete process.env.MAINTENANCE_MODE
    const config = await getConfiguration(true)
    db = await Database.init(config.dbConfig)
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
    await oceanNode.setMaintenanceMode(false)
  })

  after(async () => {
    await oceanNode.setMaintenanceMode(false)
    // Reset the OceanNode singleton we created with newInstance=true. Without this, a later
    // integration test file that calls getInstance() WITHOUT newInstance (e.g.
    // operationsDashboard) would inherit this instance — whose config has no ALLOWED_ADMINS —
    // and its admin-command validation would wrongly fail. tearDownAll() nulls the singleton
    // so the next getInstance() builds a correctly-configured one.
    await oceanNode.tearDownAll()
    await tearDownEnvironment(envOverrides)
  })

  it('rejects new compute/service/extend with 503 + code once enabled', async () => {
    await oceanNode.setMaintenanceMode(true)

    const compute = await new PaidComputeStartHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      environment: '0xhash-env',
      algorithm: {},
      datasets: [],
      maxJobDuration: 100,
      consumerAddress: CONSUMER
    } as any)
    expect(compute.status.httpStatus).to.equal(503)
    expect(compute.status.code).to.equal(MAINTENANCE_MODE_CODE)

    const init = await new ComputeInitializeHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_INITIALIZE,
      environment: '0xhash-env',
      algorithm: {},
      datasets: [],
      payment: PAYMENT,
      consumerAddress: CONSUMER
    } as any)
    expect(init.status.httpStatus).to.equal(503)
    expect(init.status.code).to.equal(MAINTENANCE_MODE_CODE)

    const svc = await new ServiceStartHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SERVICE_START,
      environment: 'env',
      image: 'ubuntu',
      duration: 100,
      payment: PAYMENT,
      consumerAddress: CONSUMER
    } as any)
    expect(svc.status.httpStatus).to.equal(503)
    expect(svc.status.code).to.equal(MAINTENANCE_MODE_CODE)

    const ext = await new ServiceExtendHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
      serviceId: 'svc-1',
      additionalDuration: 100,
      payment: PAYMENT,
      consumerAddress: CONSUMER
    } as any)
    expect(ext.status.httpStatus).to.equal(503)
    expect(ext.status.code).to.equal(MAINTENANCE_MODE_CODE)
  })

  it('status reports maintenance.enabled=true + running counts while draining', async () => {
    await oceanNode.setMaintenanceMode(true)
    const resp = await new DetailedStatusHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.DETAILED_STATUS
    } as any)
    expect(resp.status.httpStatus).to.equal(200)
    const status = await body(resp)
    expect(status.maintenance).to.not.equal(undefined)
    expect(status.maintenance.enabled).to.equal(true)
    // drain-visibility count is present as a number (the shared C2D DB may carry
    // leftover rows from other suites, so we assert the field exists rather than a fixed value)
    expect(status.maintenance.runningComputeJobs).to.be.a('number')
  })

  it('accepts work again once disabled, and status reflects it', async () => {
    await new SetMaintenanceHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SET_MAINTENANCE,
      enabled: false,
      // signature path exercised separately; here the node has no ALLOWED_ADMINS so this
      // call only reaches setMaintenanceMode if authorized — assert state directly instead.
      nonce: '1',
      address: CONSUMER,
      signature: '0xsig'
    } as any)
    // Admin auth likely rejects the above (no allowed admins), so set the known state here.
    await oceanNode.setMaintenanceMode(false)

    const compute = await new PaidComputeStartHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      environment: '0xhash-env',
      algorithm: {},
      datasets: [],
      maxJobDuration: 100,
      consumerAddress: CONSUMER
    } as any)
    expect(compute.status.code).to.not.equal(MAINTENANCE_MODE_CODE)

    const resp = await new DetailedStatusHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.DETAILED_STATUS
    } as any)
    const status = await body(resp)
    expect(status.maintenance.enabled).to.equal(false)
  })

  it('persists the flag across a simulated restart (reload from DB)', async () => {
    await oceanNode.setMaintenanceMode(true)
    // Wipe the in-memory cache and reload from the config DB, as startup does.
    ;(oceanNode as any).maintenanceMode = false
    await oceanNode.loadMaintenanceMode()
    expect(oceanNode.isInMaintenance()).to.equal(true)
    await oceanNode.setMaintenanceMode(false)
  })
})
