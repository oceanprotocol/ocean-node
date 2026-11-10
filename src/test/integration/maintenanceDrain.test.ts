import { expect, assert } from 'chai'
import { Readable } from 'stream'
import { JsonRpcProvider, Signer } from 'ethers'
import {
  ComputeGetEnvironmentsHandler,
  FreeComputeStartHandler,
  PaidComputeStartHandler,
  ComputeStopHandler,
  ComputeGetStatusHandler,
  ComputeGetResultHandler,
  ComputeGetStreamableLogsHandler
} from '../../components/core/compute/index.js'
import {
  ServiceStartHandler,
  ServiceExtendHandler
} from '../../components/core/service/index.js'
import { DetailedStatusHandler } from '../../components/core/handler/statusHandler.js'
import type {
  FreeComputeStartCommand,
  ComputeStopCommand
} from '../../@types/commands.js'
import { type ComputeEnvironment, C2DStatusNumber } from '../../@types/C2D/C2D.js'
import {
  ENVIRONMENT_VARIABLES,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { MAINTENANCE_MODE_CODE } from '../../utils/constants.js'
import { Database } from '../../components/database/index.js'
import { OceanNode } from '../../OceanNode.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { streamToObject } from '../../utils/util.js'
import { algoAsset } from '../data/assets.js'
import { RPCS } from '../../@types/blockchain.js'
import {
  OverrideEnvConfig,
  TEST_ENV_CONFIG_FILE,
  buildEnvOverrideConfig,
  getMockSupportedNetworks,
  setupEnvironment,
  tearDownEnvironment,
  sleep
} from '../utils/utils.js'
import { homedir } from 'os'
import { DEVELOPMENT_CHAIN_ID, getOceanArtifactsAdresses } from '../../utils/address.js'
import { createHashForSignature, safeSign } from '../utils/signature.js'

// A rawcode algorithm that simply stays alive for ~45s so the job is observably "running"
// while the drain assertions execute (env free.maxJobDuration is 60s). Runs under the
// c2d_examples `node $ALGO` entrypoint.
const SLEEPY_RAWCODE = [
  "console.log('maintenance-drain: starting, will stay alive ~45s')",
  'setTimeout(() => { console.log("maintenance-drain: done") }, 45000)'
].join('\n')

const PAYMENT = {
  chainId: DEVELOPMENT_CHAIN_ID,
  token: '0x0000000000000000000000000000000000000002'
}

describe('Maintenance mode — running job survives drain while new jobs are rejected (live)', function () {
  // Free compute + image pull + polling can take a while; well above the 20s default.
  this.timeout(300_000)

  let previousConfiguration: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let dbconn: Database
  let oceanNode: OceanNode
  let provider: JsonRpcProvider
  let consumerAccount: Signer
  let consumerAddress: string
  let firstEnv: ComputeEnvironment
  let runningJobId: string
  const startedJobs: string[] = []
  const mockSupportedNetworks: RPCS = getMockSupportedNetworks()

  async function buildFreeStartTask(): Promise<FreeComputeStartCommand> {
    const nonce = Date.now().toString()
    const signature = await safeSign(
      consumerAccount,
      createHashForSignature(consumerAddress, nonce, PROTOCOL_COMMANDS.FREE_COMPUTE_START)
    )
    return {
      command: PROTOCOL_COMMANDS.FREE_COMPUTE_START,
      consumerAddress,
      signature,
      nonce,
      environment: firstEnv.id,
      queueMaxWaitTime: 0,
      datasets: [],
      algorithm: {
        meta: {
          ...algoAsset.metadata.algorithm,
          rawcode: SLEEPY_RAWCODE
        }
      },
      output: null
    } as FreeComputeStartCommand
  }

  async function stopJob(fullJobId: string): Promise<number> {
    const nonce = Date.now().toString()
    const signature = await safeSign(
      consumerAccount,
      createHashForSignature(consumerAddress, nonce, PROTOCOL_COMMANDS.COMPUTE_STOP)
    )
    const task: ComputeStopCommand = {
      command: PROTOCOL_COMMANDS.COMPUTE_STOP,
      consumerAddress,
      signature,
      nonce,
      jobId: fullJobId
    } as ComputeStopCommand
    const resp = await new ComputeStopHandler(oceanNode).handle(task)
    return resp.status.httpStatus
  }

  before(async () => {
    const artifactsAddresses = getOceanArtifactsAdresses()
    const paymentToken = artifactsAddresses.development.Ocean
    previousConfiguration = await setupEnvironment(
      TEST_ENV_CONFIG_FILE,
      buildEnvOverrideConfig(
        [
          ENVIRONMENT_VARIABLES.RPCS,
          ENVIRONMENT_VARIABLES.INDEXER_NETWORKS,
          ENVIRONMENT_VARIABLES.PRIVATE_KEY,
          ENVIRONMENT_VARIABLES.ADDRESS_FILE,
          ENVIRONMENT_VARIABLES.MAINTENANCE_MODE,
          ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS
        ],
        [
          JSON.stringify(mockSupportedNetworks),
          JSON.stringify([DEVELOPMENT_CHAIN_ID]),
          '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
          '',
          '[{"socketPath":"/var/run/docker.sock","environments":[{"storageExpiry":604800,"maxJobDuration":3600,"minJobDuration":60,"resources":[{"id":"cpu","total":4,"max":4,"min":1,"type":"cpu"},{"id":"ram","total":10,"max":10,"min":1,"type":"ram"},{"id":"disk","total":10,"max":10,"min":0,"type":"disk"}],"fees":{"' +
            DEVELOPMENT_CHAIN_ID +
            '":[{"feeToken":"' +
            paymentToken +
            '","prices":[{"id":"cpu","price":1}]}]},"free":{"maxJobDuration":60,"minJobDuration":10,"maxJobs":3,"resources":[{"id":"cpu","max":1},{"id":"ram","max":1},{"id":"disk","max":1}]}}]}]'
        ]
      )
    )
    // Env override must not leave the node booted into maintenance.
    delete process.env.MAINTENANCE_MODE
    config = await getConfiguration(true)
    dbconn = await Database.init(config.dbConfig)
    // The c2d DB is shared across suites/runs; clear stale not-finished jobs so we don't trip
    // the free env's maxJobs ceiling (mirrors the compute suite's before()).
    const staleJobs = await dbconn.c2d.getRunningJobs()
    for (const job of staleJobs) {
      await dbconn.c2d.deleteJob(job.jobId)
    }
    oceanNode = OceanNode.getInstance(config, dbconn, null, null, null, null, null, true)
    await oceanNode.addC2DEngines()
    await oceanNode.setMaintenanceMode(false)

    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    consumerAccount = (await provider.getSigner(1)) as Signer
    consumerAddress = await consumerAccount.getAddress()
  })

  after(async () => {
    // Stop anything we started, then disable maintenance and tear down.
    for (const id of startedJobs) {
      try {
        await stopJob(id)
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      await oceanNode.setMaintenanceMode(false)
    } catch {
      /* ignore */
    }
    await oceanNode.tearDownAll()
    await tearDownEnvironment(previousConfiguration)
  })

  it('resolves a free compute environment', async () => {
    const resp = await new ComputeGetEnvironmentsHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_GET_ENVIRONMENTS,
      caller: '127.0.0.1'
    } as any)
    assert.equal(resp.status.httpStatus, 200, String(resp.status.error))
    const envs: ComputeEnvironment[] = await streamToObject(resp.stream as Readable)
    assert(envs.length > 0, 'no compute environments available (is Barge c2d up?)')
    firstEnv = envs[0]
    assert(firstEnv.free, 'the resolved environment has no free tier configured')
  })

  it('starts a real free compute job and polls until it is running', async () => {
    const startRes = await new FreeComputeStartHandler(oceanNode).handle(
      await buildFreeStartTask()
    )
    assert.equal(
      startRes.status.httpStatus,
      200,
      `free compute start failed (infra?): ${startRes.status.error}`
    )
    const started = await streamToObject(startRes.stream as Readable)
    runningJobId = started[0].jobId as string
    startedJobs.push(runningJobId)

    // Poll until the job is in a non-finished, non-failed in-progress state.
    const deadline = Date.now() + 180_000
    let running = false
    while (Date.now() < deadline) {
      const r = await new ComputeGetStatusHandler(oceanNode).handle({
        command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
        consumerAddress: null,
        agreementId: null,
        jobId: runningJobId
      } as any)
      assert.equal(r.status.httpStatus, 200)
      const jobs = await streamToObject(r.stream as Readable)
      const j = jobs[0]
      if (j) {
        const failed =
          j.status === C2DStatusNumber.PullImageFailed ||
          j.status === C2DStatusNumber.DataProvisioningFailed ||
          j.status === C2DStatusNumber.AlgorithmProvisioningFailed
        if (failed || (j.dateFinished && j.status >= C2DStatusNumber.JobFinished)) {
          assert.fail(
            `job reached a terminal state (${j.status} ${j.statusText}) before we could drain-test it`
          )
        }
        // JobStarted(0)..RunningAlgorithm(40): resource-holding, observably in-flight
        if (j.status >= C2DStatusNumber.JobStarted && !j.dateFinished) {
          running = true
          break
        }
      }
      await sleep(2000)
    }
    assert(running, 'job did not reach a running state within timeout')
  })

  it('while draining: rejects NEW jobs but keeps serving the running one', async () => {
    await oceanNode.setMaintenanceMode(true)

    // --- NEW commitment is rejected with 503 + MAINTENANCE_MODE ---
    const newFree = await new FreeComputeStartHandler(oceanNode).handle(
      await buildFreeStartTask()
    )
    expect(newFree.status.httpStatus).to.equal(503)
    expect(newFree.status.code).to.equal(MAINTENANCE_MODE_CODE)

    const newPaid = await new PaidComputeStartHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_START,
      environment: firstEnv.id,
      algorithm: { meta: { ...algoAsset.metadata.algorithm, rawcode: SLEEPY_RAWCODE } },
      datasets: [],
      maxJobDuration: 60,
      payment: PAYMENT,
      consumerAddress
    } as any)
    expect(newPaid.status.httpStatus).to.equal(503)
    expect(newPaid.status.code).to.equal(MAINTENANCE_MODE_CODE)

    const newService = await new ServiceStartHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SERVICE_START,
      environment: firstEnv.id,
      image: 'ubuntu',
      duration: 100,
      payment: PAYMENT,
      consumerAddress
    } as any)
    expect(newService.status.httpStatus).to.equal(503)
    expect(newService.status.code).to.equal(MAINTENANCE_MODE_CODE)

    const newExtend = await new ServiceExtendHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.SERVICE_EXTEND,
      serviceId: 'svc-1',
      additionalDuration: 100,
      payment: PAYMENT,
      consumerAddress
    } as any)
    expect(newExtend.status.httpStatus).to.equal(503)
    expect(newExtend.status.code).to.equal(MAINTENANCE_MODE_CODE)

    // --- detailed status reflects the drain + the live job ---
    const statusResp = await new DetailedStatusHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.DETAILED_STATUS
    } as any)
    const status = await streamToObject(statusResp.stream as Readable)
    expect(status.maintenance.enabled).to.equal(true)
    expect(status.maintenance.runningComputeJobs).to.be.a('number')
    expect(status.maintenance.runningComputeJobs).to.be.at.least(1)

    // --- the ALREADY-RUNNING job is still fully serviceable ---
    const statusRunning = await new ComputeGetStatusHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STATUS,
      consumerAddress: null,
      agreementId: null,
      jobId: runningJobId
    } as any)
    expect(statusRunning.status.httpStatus).to.equal(200)
    expect(statusRunning.status.code).to.not.equal(MAINTENANCE_MODE_CODE)
    const runningJobs = await streamToObject(statusRunning.stream as Readable)
    // getComputeStatus returns the job keyed by its inner id, while start returned the full
    // "<clusterHash>-<innerId>" id — match on either so the check is format-robust.
    expect(
      runningJobs.some(
        (j: any) => j.jobId === runningJobId || runningJobId.endsWith(`-${j.jobId}`)
      ),
      'the already-running job must still be returned by getComputeStatus during maintenance'
    ).to.equal(true)

    // logs + result reads must not be blocked by maintenance (they may 4xx for timing
    // reasons — results not ready — but never with the maintenance code)
    const logsNonce = Date.now().toString()
    const logsSig = await safeSign(
      consumerAccount,
      createHashForSignature(
        consumerAddress,
        logsNonce,
        PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS
      )
    )
    const logs = await new ComputeGetStreamableLogsHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_GET_STREAMABLE_LOGS,
      consumerAddress,
      jobId: runningJobId,
      nonce: logsNonce,
      signature: logsSig
    } as any)
    expect(logs.status.code).to.not.equal(MAINTENANCE_MODE_CODE)

    const resNonce = Date.now().toString()
    const resSig = await safeSign(
      consumerAccount,
      createHashForSignature(
        consumerAddress,
        resNonce,
        PROTOCOL_COMMANDS.COMPUTE_GET_RESULT
      )
    )
    const result = await new ComputeGetResultHandler(oceanNode).handle({
      command: PROTOCOL_COMMANDS.COMPUTE_GET_RESULT,
      consumerAddress,
      jobId: runningJobId,
      nonce: resNonce,
      signature: resSig,
      index: 0
    } as any)
    expect(result.status.code).to.not.equal(MAINTENANCE_MODE_CODE)

    // --- stopCompute on the running job SUCCEEDS during maintenance ---
    const stopStatus = await stopJob(runningJobId)
    expect(stopStatus).to.equal(200)
  })

  it('accepts new free compute again once maintenance is disabled', async () => {
    await oceanNode.setMaintenanceMode(false)
    const resp = await new FreeComputeStartHandler(oceanNode).handle(
      await buildFreeStartTask()
    )
    expect(resp.status.code).to.not.equal(MAINTENANCE_MODE_CODE)
    expect(resp.status.httpStatus).to.equal(200)
    const started = await streamToObject(resp.stream as Readable)
    const newId = started[0].jobId as string
    startedJobs.push(newId)
    // stop it so we leave the engine clean
    await stopJob(newId)
  })
})
