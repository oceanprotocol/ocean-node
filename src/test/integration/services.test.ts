import { expect, assert } from 'chai'
import {
  ServiceGetTemplatesHandler,
  ServiceStartHandler,
  ServiceStopHandler,
  ServiceExtendHandler,
  ServiceRestartHandler,
  ServiceGetStatusHandler
} from '../../components/core/service/index.js'
import { ComputeGetEnvironmentsHandler } from '../../components/core/compute/index.js'
import type {
  ServiceGetTemplatesCommand,
  ServiceStartCommand,
  ServiceStopCommand,
  ServiceExtendCommand,
  ServiceRestartCommand,
  ServiceGetStatusCommand
} from '../../@types/commands.js'
import {
  ServiceStatusNumber,
  type ServiceJob,
  type ServiceTemplatePublic
} from '../../@types/C2D/ServiceOnDemand.js'
import type { ComputeEnvironment } from '../../@types/C2D/C2D.js'
import {
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { Readable } from 'stream'
import { streamToObject } from '../../utils/util.js'
import { ethers, JsonRpcProvider, Signer } from 'ethers'
import { RPCS } from '../../@types/blockchain.js'
import {
  DEFAULT_TEST_TIMEOUT,
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment,
  sleep
} from '../utils/utils.js'
import { DEVELOPMENT_CHAIN_ID, getOceanArtifactsAdresses } from '../../utils/address.js'
import OceanToken from '@oceanprotocol/contracts/artifacts/contracts/utils/OceanToken.sol/OceanToken.json' with { type: 'json' }
import EscrowJson from '@oceanprotocol/contracts/artifacts/contracts/escrow/Escrow.sol/Escrow.json' with { type: 'json' }
import { EncryptMethod } from '../../@types/fileObject.js'
import { createHashForSignature, safeSign } from '../utils/signature.js'
import { C2DEngineDocker } from '../../components/c2d/compute_engine_docker.js'
import Dockerode from 'dockerode'
import fsp from 'fs/promises'
import path from 'path'
import { tmpdir } from 'os'

const TEMPLATE_ID = 'nginx-demo'
const MAX_DURATION = 600 // serviceOnDemand.maxDurationSeconds
const SERVICE_DURATION = 300 // long-lived service used through tests (d)→(l)
const EXPIRY_DURATION = 60 // short service for the expiry-cron test
const PORT_RANGE_START = 39000
const PORT_RANGE_END = 39500

const TEMPLATE_JSON = {
  id: TEMPLATE_ID,
  name: 'Nginx demo',
  image: 'nginx',
  tag: 'alpine',
  exposedPorts: [80],
  requiredResources: [
    { id: 'cpu', min: 1 },
    { id: 'ram', min: 1 }
  ],
  userConfigurableEnvVars: [{ key: 'EXTRA', validation: '^[a-zA-Z0-9]{1,20}$' }]
}

describe('**********         Service on Demand', () => {
  let previousConfiguration: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let publisherAccount: Signer
  let consumerAccount: Signer
  let nonOwnerAccount: Signer
  let consumerAddress: string
  let paymentToken: any
  let paymentTokenContract: any
  let escrowContract: any
  let artifactsAddresses: any
  let serviceTemplatesPath: string
  let servicesEnv: ComputeEnvironment
  let noServicesEnv: ComputeEnvironment

  // state threaded through the lifecycle tests
  let serviceId: string
  let hostPort: number
  let expiresAt: number
  let endpointUrl: string
  const startedServices: string[] = []

  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  // ── helpers ──────────────────────────────────────────────────────────

  async function signFor(signer: Signer, command: string) {
    const addr = await signer.getAddress()
    const nonce = Date.now().toString()
    const hash = createHashForSignature(addr, nonce, command)
    const signature = await safeSign(signer, hash)
    return { consumerAddress: addr, nonce, signature }
  }

  async function encryptUserData(obj: Record<string, unknown>): Promise<string> {
    const enc = await oceanNode
      .getKeyManager()
      .encrypt(new Uint8Array(Buffer.from(JSON.stringify(obj))), EncryptMethod.ECIES)
    return Buffer.from(enc).toString('hex')
  }

  async function fundEscrow(beneficiaryNodeAddr: string, durationForLock: number) {
    let balance = await paymentTokenContract.balanceOf(consumerAddress)
    if (BigInt(balance.toString()) === BigInt(0)) {
      const mintTx = await paymentTokenContract.mint(
        consumerAddress,
        ethers.parseUnits('1000', 18)
      )
      await mintTx.wait()
      balance = await paymentTokenContract.balanceOf(consumerAddress)
    }
    await (
      await paymentTokenContract
        .connect(consumerAccount)
        .approve(artifactsAddresses.development.Escrow, balance)
    ).wait()
    await (
      await escrowContract.connect(consumerAccount).deposit(paymentToken, balance)
    ).wait()
    const minLockSeconds = oceanNode.escrow.getMinLockTime(durationForLock)
    await (
      await escrowContract
        .connect(consumerAccount)
        .authorize(paymentToken, beneficiaryNodeAddr, balance, minLockSeconds, 10)
    ).wait()
    return await oceanNode.escrow.getUserAvailableFunds(
      DEVELOPMENT_CHAIN_ID,
      consumerAddress,
      paymentToken
    )
  }

  async function getServiceJob(id: string): Promise<ServiceJob | undefined> {
    const { nonce, signature } = await signFor(
      consumerAccount,
      PROTOCOL_COMMANDS.SERVICE_GET_STATUS
    )
    const r = await new ServiceGetStatusHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SERVICE_GET_STATUS,
      serviceId: id,
      consumerAddress,
      nonce,
      signature
    } as ServiceGetStatusCommand)
    const jobs = (await streamToObject(r.stream as Readable)) as ServiceJob[]
    return jobs.find((j) => j.serviceId === id)
  }

  async function pollServiceStatus(
    id: string,
    target: ServiceStatusNumber,
    timeoutMs = DEFAULT_TEST_TIMEOUT * 3
  ): Promise<ServiceJob> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const job = await getServiceJob(id)
      if (job && job.status === target) return job
      if (
        job &&
        (job.status === ServiceStatusNumber.Error ||
          job.status === ServiceStatusNumber.PullImageFailed ||
          job.status === ServiceStatusNumber.BuildImageFailed)
      ) {
        throw new Error(
          `service ${id} entered failure state ${job.status}: ${job.statusText}`
        )
      }
      await sleep(3000)
    }
    throw new Error(`pollServiceStatus(${id}) timed out waiting for status ${target}`)
  }

  async function httpGetWithRetry(
    url: string,
    tries = 4
  ): Promise<{ ok: boolean; status: number; body: string }> {
    let lastErr: any
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url)
        const body = await res.text()
        return { ok: res.ok, status: res.status, body }
      } catch (e) {
        lastErr = e
        await sleep(1500)
      }
    }
    throw lastErr
  }

  function getDockerEngine(): C2DEngineDocker {
    const engines = (oceanNode.getC2DEngines() as any).engines as C2DEngineDocker[]
    return engines.find((e) => e instanceof C2DEngineDocker) as C2DEngineDocker
  }

  // ── setup / teardown ─────────────────────────────────────────────────

  before(async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 3)
    artifactsAddresses = getOceanArtifactsAdresses()
    paymentToken = artifactsAddresses.development.Ocean

    // Write the template file BEFORE building the configuration.
    serviceTemplatesPath = await fsp.mkdtemp(path.join(tmpdir(), 'ocean-svc-tmpl-'))
    await fsp.writeFile(
      path.join(serviceTemplatesPath, 'nginx-demo.json'),
      JSON.stringify(TEMPLATE_JSON),
      'utf8'
    )

    const dockerEnvs =
      '[{"socketPath":"/var/run/docker.sock",' +
      '"serviceOnDemand":{"enabled":true,"nodeHost":"localhost","hostPortRange":[' +
      PORT_RANGE_START +
      ',' +
      PORT_RANGE_END +
      '],"maxDurationSeconds":' +
      MAX_DURATION +
      ',"allowImageBuild":true},' +
      '"environments":[' +
      '{"storageExpiry":604800,"maxJobDuration":3600,"minJobDuration":60,"features":{"computeJobs":true,"services":true},' +
      '"resources":[{"id":"cpu","total":4,"max":4,"min":1,"type":"cpu"},{"id":"ram","total":10,"max":10,"min":1,"type":"ram"},{"id":"disk","total":10,"max":10,"min":0,"type":"disk"}],' +
      '"fees":{"' +
      DEVELOPMENT_CHAIN_ID +
      '":[{"feeToken":"' +
      paymentToken +
      '","prices":[{"id":"cpu","price":1},{"id":"ram","price":1}]}]}},' +
      '{"storageExpiry":604800,"maxJobDuration":3600,"minJobDuration":60,"features":{"computeJobs":true,"services":false},' +
      '"resources":[{"id":"cpu","total":2,"max":2,"min":1,"type":"cpu"},{"id":"ram","total":4,"max":4,"min":1,"type":"ram"},{"id":"disk","total":4,"max":4,"min":0,"type":"disk"}],' +
      '"fees":{"' +
      DEVELOPMENT_CHAIN_ID +
      '":[{"feeToken":"' +
      paymentToken +
      '","prices":[{"id":"cpu","price":1},{"id":"ram","price":1}]}]}}' +
      ']}]'

    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.AUTHORIZED_DECRYPTERS,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE,
          ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS,
          ENVIRONMENT_VARIABLES.SERVICE_TEMPLATES_PATH
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([DEVELOPMENT_CHAIN_ID]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          JSON.stringify(['0xe2DD09d719Da89e5a3D0F2549c7E24566e947260']),
          `${process.env.HOME}/.ocean/ocean-contracts/artifacts/address.json`,
          dockerEnvs,
          serviceTemplatesPath
        ]
      )
    )

    config = await getConfiguration(true)
    assert(
      config.serviceTemplatesPath === serviceTemplatesPath,
      'serviceTemplatesPath not applied to config'
    )
    dbconn = await Database.init(config.dbConfig)

    // Clean stale running service jobs so prior runs don't consume shared resources.
    const staleServices = await dbconn.c2d.getRunningServiceJobs()
    for (const svc of staleServices) {
      svc.status = ServiceStatusNumber.Stopped
      svc.statusText = 'Stopped'
      await dbconn.c2d.updateServiceJob(svc)
    }
    const staleJobs = await dbconn.c2d.getRunningJobs()
    for (const job of staleJobs) {
      await dbconn.c2d.deleteJob(job.jobId)
    }

    oceanNode = OceanNode.getInstance(config, dbconn, null, null, null, null, null, true)
    await oceanNode.addC2DEngines()

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    nonOwnerAccount = (await provider.getSigner(3)) as Signer
    consumerAddress = await consumerAccount.getAddress()

    paymentTokenContract = new ethers.Contract(
      paymentToken,
      OceanToken.abi,
      publisherAccount
    )
    escrowContract = new ethers.Contract(
      artifactsAddresses.development.Escrow,
      EscrowJson.abi,
      publisherAccount
    )
  })

  after(async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    // Best-effort: stop every service this suite started so no container/network/port leaks.
    try {
      const engine = getDockerEngine()
      if (engine) {
        for (const id of startedServices) {
          await engine.stopService(id, consumerAddress).catch(() => {})
        }
      }
    } catch {
      /* ignore */
    }
    if (oceanNode) await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
    if (serviceTemplatesPath) {
      await fsp.rm(serviceTemplatesPath, { recursive: true, force: true })
    }
  })

  // ── tests ────────────────────────────────────────────────────────────

  it('(a) sets up the service environment', () => {
    assert(oceanNode, 'Failed to instantiate OceanNode')
    assert(config.c2dClusters, 'Failed to get c2dClusters')
    assert(config.serviceTemplatesPath === serviceTemplatesPath, 'wrong templates path')
    assert(getDockerEngine(), 'No docker engine configured')
  })

  it('(b) SERVICE_GET_TEMPLATES returns the sanitized template catalogue', async () => {
    const resp = await new ServiceGetTemplatesHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SERVICE_GET_TEMPLATES
    } as ServiceGetTemplatesCommand)
    assert(resp.status.httpStatus === 200, 'expected 200')
    const templates = (await streamToObject(
      resp.stream as Readable
    )) as ServiceTemplatePublic[]
    const tmpl = templates.find((t) => t.id === TEMPLATE_ID)
    assert(tmpl, 'nginx-demo template not returned')
    // compatibleEnvironments was removed — picking an env is the client's job.
    expect((tmpl as any).compatibleEnvironments).to.equal(undefined)

    // Classify the two environments by their own features.services flag.
    const envResp = await new ComputeGetEnvironmentsHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS
    })
    const envs = (await streamToObject(
      envResp.stream as Readable
    )) as ComputeEnvironment[]
    assert(envs.length >= 2, 'expected at least 2 environments')
    servicesEnv = envs.find((e) => e.features?.services === true)
    noServicesEnv = envs.find((e) => e.features?.services === false)
    assert(servicesEnv, 'services-enabled env not found')
    assert(noServicesEnv, 'services-disabled env not found')
  })

  it('(c) funds the escrow for the consumer', async () => {
    const funds = await fundEscrow(servicesEnv.consumerAddress, MAX_DURATION)
    assert(BigInt(funds.toString()) > BigInt(0), 'Should have funds in escrow')
  })

  it('(d) SERVICE_START (nginx) → Running, endpoint reachable over HTTP', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 4)
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_START)
    const task: ServiceStartCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      consumerAddress: addr,
      nonce,
      signature,
      environment: servicesEnv.id,
      image: 'nginx',
      tag: 'alpine',
      exposedPorts: [80],
      duration: SERVICE_DURATION,
      resources: [
        { id: 'cpu', amount: 1 },
        { id: 'ram', amount: 1 }
      ],
      userData: await encryptUserData({ EXTRA: 'hello123' }),
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceStartHandler(oceanNode).handle(task)
    assert(
      resp.status.httpStatus === 200,
      `expected 200, got ${resp.status.httpStatus}: ${resp.status?.error ?? ''}`
    )
    const [job] = (await streamToObject(resp.stream as Readable)) as ServiceJob[]
    assert(job.serviceId, 'no serviceId returned')
    serviceId = job.serviceId
    startedServices.push(serviceId)

    const running = await pollServiceStatus(serviceId, ServiceStatusNumber.Running)
    assert(running.endpoints.length === 1, 'expected one endpoint')
    hostPort = running.endpoints[0].hostPort
    endpointUrl = running.endpoints[0].url
    expiresAt = running.expiresAt
    expect(hostPort).to.be.within(PORT_RANGE_START, PORT_RANGE_END)
    expect(endpointUrl).to.equal(`http://localhost:${hostPort}`)

    const res = await httpGetWithRetry(endpointUrl)
    assert(res.status === 200, `expected nginx HTTP 200, got ${res.status}`)
    assert(res.body.toLowerCase().includes('nginx'), 'body should be the nginx page')
  })

  it('(e) SERVICE_GET_STATUS returns the job with userData stripped', async () => {
    const job = await getServiceJob(serviceId)
    assert(job, 'job not found')
    expect(job.serviceId).to.equal(serviceId)
    expect((job as any).userData).to.equal(undefined)
    assert(job.payment, 'payment should be present')

    // an unauthenticated status request (no nonce/signature) is rejected
    const unauth = await new ServiceGetStatusHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SERVICE_GET_STATUS,
      consumerAddress,
      serviceId
    } as ServiceGetStatusCommand)
    expect(unauth.status.httpStatus).to.not.equal(200)
  })

  it('(f) SERVICE_START on a services-disabled environment → 403', async () => {
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_START)
    const task: ServiceStartCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      consumerAddress: addr,
      nonce,
      signature,
      environment: noServicesEnv.id,
      image: 'nginx',
      tag: 'alpine',
      exposedPorts: [80],
      duration: SERVICE_DURATION,
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceStartHandler(oceanNode).handle(task)
    expect(resp.status.httpStatus).to.equal(403)
  })

  it('(g) SERVICE_START with duration > maxDurationSeconds → 400', async () => {
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_START)
    const task: ServiceStartCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      consumerAddress: addr,
      nonce,
      signature,
      environment: servicesEnv.id,
      image: 'nginx',
      tag: 'alpine',
      exposedPorts: [80],
      duration: MAX_DURATION + 1,
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceStartHandler(oceanNode).handle(task)
    expect(resp.status.httpStatus).to.equal(400)
  })

  it('(h) SERVICE_START with undecryptable userData → 400', async () => {
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_START)
    const task: ServiceStartCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      consumerAddress: addr,
      nonce,
      signature,
      environment: servicesEnv.id,
      image: 'nginx',
      tag: 'alpine',
      exposedPorts: [80],
      duration: SERVICE_DURATION,
      // not ECIES-encrypted to the node key → decrypt must fail
      userData: Buffer.from('not-encrypted-userData').toString('hex'),
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceStartHandler(oceanNode).handle(task)
    expect(resp.status.httpStatus).to.equal(400)
  })

  it('(i) SERVICE_EXTEND advances expiresAt and records an extendPayment', async () => {
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_EXTEND)
    const task: ServiceExtendCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
      consumerAddress: addr,
      nonce,
      signature,
      serviceId,
      additionalDuration: 30,
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceExtendHandler(oceanNode).handle(task)
    assert(
      resp.status.httpStatus === 200,
      `expected 200, got ${resp.status.httpStatus}: ${resp.status?.error ?? ''}`
    )
    const [job] = (await streamToObject(resp.stream as Readable)) as ServiceJob[]
    expect(job.expiresAt).to.equal(expiresAt + 30 * 1000)
    expect(job.extendPayments?.length).to.equal(1)
    expiresAt = job.expiresAt
  })

  it('(j) SERVICE_EXTEND by a non-owner is rejected (non-200)', async () => {
    // In a real DB, getServiceJob filters by owner, so a non-owner lookup returns
    // "not found" (400) rather than reaching the 401 ownership branch.
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(nonOwnerAccount, PROTOCOL_COMMANDS.SERVICE_EXTEND)
    const task: ServiceExtendCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
      consumerAddress: addr,
      nonce,
      signature,
      serviceId,
      additionalDuration: 30,
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceExtendHandler(oceanNode).handle(task)
    expect(resp.status.httpStatus).to.not.equal(200)
  })

  it('(k) SERVICE_RESTART → new container, same hostPort + expiresAt', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 4)
    const before = await getServiceJob(serviceId)
    const oldContainerId = before.containerId

    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_RESTART)
    const task: ServiceRestartCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_RESTART,
      consumerAddress: addr,
      nonce,
      signature,
      serviceId
    }
    const resp = await new ServiceRestartHandler(oceanNode).handle(task)
    assert(
      resp.status.httpStatus === 200,
      `expected 200, got ${resp.status.httpStatus}: ${resp.status?.error ?? ''}`
    )
    const running = await pollServiceStatus(serviceId, ServiceStatusNumber.Running)
    expect(running.containerId).to.not.equal(oldContainerId)
    expect(running.endpoints[0].hostPort).to.equal(hostPort)
    expect(running.expiresAt).to.equal(expiresAt)

    const res = await httpGetWithRetry(endpointUrl)
    assert(res.status === 200, `expected nginx HTTP 200 after restart, got ${res.status}`)
  })

  it('(l) SERVICE_STOP → Stopped, container + network removed', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 2)
    const before = await getServiceJob(serviceId)
    const { containerId } = before

    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_STOP)
    const task: ServiceStopCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_STOP,
      consumerAddress: addr,
      nonce,
      signature,
      serviceId
    }
    const resp = await new ServiceStopHandler(oceanNode).handle(task)
    assert(
      resp.status.httpStatus === 200,
      `expected 200, got ${resp.status.httpStatus}: ${resp.status?.error ?? ''}`
    )
    const [job] = (await streamToObject(resp.stream as Readable)) as ServiceJob[]
    expect(job.status).to.equal(ServiceStatusNumber.Stopped)

    // container should be gone
    const docker = new Dockerode()
    let inspectFailed = false
    try {
      await docker.getContainer(containerId).inspect()
    } catch {
      inspectFailed = true
    }
    assert(inspectFailed, 'container should have been removed')
  })

  it('(m) [slow] expiry cron marks a short-lived service Expired', async function () {
    this.timeout(150000)
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_START)
    const task: ServiceStartCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      consumerAddress: addr,
      nonce,
      signature,
      environment: servicesEnv.id,
      image: 'nginx',
      tag: 'alpine',
      exposedPorts: [80],
      duration: EXPIRY_DURATION,
      resources: [
        { id: 'cpu', amount: 1 },
        { id: 'ram', amount: 1 }
      ],
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceStartHandler(oceanNode).handle(task)
    assert(resp.status.httpStatus === 200, `start failed: ${resp.status?.error ?? ''}`)
    const [job] = (await streamToObject(resp.stream as Readable)) as ServiceJob[]
    startedServices.push(job.serviceId)
    await pollServiceStatus(job.serviceId, ServiceStatusNumber.Running)
    // wait out the duration; the InternalLoop cron (~2s) stops+expires it
    const expired = await pollServiceStatus(
      job.serviceId,
      ServiceStatusNumber.Expired,
      (EXPIRY_DURATION + 40) * 1000
    )
    expect(expired.status).to.equal(ServiceStatusNumber.Expired)
  })

  it('(n) [build] Dockerfile-based custom service builds and serves', async function () {
    this.timeout(DEFAULT_TEST_TIMEOUT * 8)
    const {
      consumerAddress: addr,
      nonce,
      signature
    } = await signFor(consumerAccount, PROTOCOL_COMMANDS.SERVICE_START)
    const dockerfile =
      'FROM nginx:alpine\nRUN echo built > /usr/share/nginx/html/built.txt\n'
    const task: ServiceStartCommand = {
      command: PROTOCOL_COMMANDS.SERVICE_START,
      consumerAddress: addr,
      nonce,
      signature,
      environment: servicesEnv.id,
      image: 'custom-svc',
      dockerfile,
      dockerCmd: ['nginx', '-g', 'daemon off;'],
      exposedPorts: [80],
      duration: SERVICE_DURATION,
      resources: [
        { id: 'cpu', amount: 1 },
        { id: 'ram', amount: 1 }
      ],
      payment: { chainId: DEVELOPMENT_CHAIN_ID, token: paymentToken }
    }
    const resp = await new ServiceStartHandler(oceanNode).handle(task)
    assert(
      resp.status.httpStatus === 200,
      `expected 200, got ${resp.status.httpStatus}: ${resp.status?.error ?? ''}`
    )
    const [job] = (await streamToObject(resp.stream as Readable)) as ServiceJob[]
    startedServices.push(job.serviceId)
    const running = await pollServiceStatus(
      job.serviceId,
      ServiceStatusNumber.Running,
      DEFAULT_TEST_TIMEOUT * 8
    )
    const { url } = running.endpoints[0]
    const res = await httpGetWithRetry(`${url}/built.txt`)
    assert(res.status === 200, `expected built.txt HTTP 200, got ${res.status}`)
    assert(res.body.includes('built'), 'built.txt should contain "built"')

    // stop it
    await getDockerEngine().stopService(job.serviceId, consumerAddress)
  })
})
