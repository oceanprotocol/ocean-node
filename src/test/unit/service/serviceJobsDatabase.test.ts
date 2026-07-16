import { assert, expect } from 'chai'
import { Readable } from 'stream'
import { C2DDatabase } from '../../../components/database/C2DDatabase.js'
import { typesenseSchemas } from '../../../components/database/TypesenseSchemas.js'
import { getConfiguration } from '../../../utils/config.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import { OceanNodeConfig } from '../../../@types/OceanNode.js'
import {
  C2DClusterType,
  ComputeEnvironment,
  ComputeJob,
  ComputeResource
} from '../../../@types/C2D/C2D.js'
import { ServiceJob, ServiceStatusNumber } from '../../../@types/C2D/ServiceOnDemand.js'
import { C2DEngine } from '../../../components/c2d/compute_engine_base.js'
import { ValidateParams } from '../../../components/httpRoutes/validateCommands.js'

const CLUSTER_HASH = 'svc-test-cluster'

/* eslint-disable require-await */
// Minimal concrete engine bound to a real DB + cluster hash, so we can exercise
// getUsedResources() (which reads running compute + service jobs from the DB).
class SharedAccountingEngine extends C2DEngine {
  constructor(db: C2DDatabase) {
    super({ type: C2DClusterType.DOCKER, hash: CLUSTER_HASH }, db, null, null, null)
  }

  setLimits(limits: Map<string, number>) {
    this.physicalLimits = limits
  }

  async getComputeEnvironments(): Promise<ComputeEnvironment[]> {
    return []
  }

  async checkDockerImage(): Promise<ValidateParams> {
    return { valid: true, reason: null as string, status: 200 }
  }

  async startComputeJob(): Promise<ComputeJob[]> {
    return []
  }

  async stopComputeJob(): Promise<ComputeJob[]> {
    return []
  }

  async getComputeJobStatus(): Promise<ComputeJob[]> {
    return []
  }

  async getComputeJobResult(): Promise<{ stream: Readable; headers: any }> {
    return null
  }

  async cleanupExpiredStorage(): Promise<boolean> {
    return true
  }
}
/* eslint-enable require-await */

function makeEnv(id: string, resources: ComputeResource[]): ComputeEnvironment {
  return {
    id,
    resources,
    runningJobs: 0,
    runningfreeJobs: 0,
    queuedJobs: 0,
    queuedFreeJobs: 0,
    queMaxWaitTime: 0,
    queMaxWaitTimeFree: 0,
    runMaxWaitTime: 0,
    runMaxWaitTimeFree: 0,
    consumerAddress: '0x0',
    fees: {},
    access: { addresses: [], accessLists: null },
    platform: { architecture: 'x86_64', os: 'linux' },
    minJobDuration: 60,
    maxJobDuration: 3600,
    maxJobs: 10
  } as ComputeEnvironment
}

function makeServiceJob(overrides: Partial<ServiceJob> = {}): ServiceJob {
  return {
    serviceId: 'svc-' + Math.random().toString(36).slice(2),
    clusterHash: CLUSTER_HASH,
    environment: 'env-a',
    owner: '0xowner',
    image: 'quay.io/jupyter/datascience-notebook',
    tag: 'latest',
    containerImage: 'quay.io/jupyter/datascience-notebook:latest',
    containerId: 'container-1',
    networkId: 'network-1',
    status: ServiceStatusNumber.Running,
    statusText: 'Running',
    dateCreated: new Date(0).toISOString(),
    expiresAt: Date.now() + 3600_000,
    duration: 3600,
    exposedPorts: [8888],
    endpoints: [{ containerPort: 8888, hostPort: 31000, url: 'http://localhost:31000' }],
    userData: 'ENCRYPTED_BLOB',
    resources: [{ id: 'cpu', amount: 2 }],
    payment: {
      chainId: 8996,
      token: '0x123',
      lockTx: '0xlock',
      claimTx: '0xclaim',
      cancelTx: '',
      cost: 5
    },
    ...overrides
  }
}

describe('Service Jobs Database', () => {
  let envOverrides: OverrideEnvConfig[]
  let config: OceanNodeConfig
  let db: C2DDatabase = null

  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.DOCKER_COMPUTE_ENVIRONMENTS],
      [
        '[{"socketPath":"/var/run/docker.sock","environments":[{"storageExpiry":604800,"maxJobDuration":3600,"minJobDuration":60,"resources":[{"id":"cpu","total":4,"max":4,"min":1,"type":"cpu"}],"fees":{"1":[{"feeToken":"0x123","prices":[{"id":"cpu","price":1}]}]}}]}]'
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    config = await getConfiguration(true)
    db = await new C2DDatabase(config.dbConfig, typesenseSchemas.c2dSchemas)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })

  describe('service lifecycle locks (cross-process lease)', () => {
    const STALE_MS = 60_000

    it('grants the lock to exactly one holder and rejects a second acquire', async () => {
      const serviceId = `lock-svc-${Date.now()}-a`
      expect(await db.acquireServiceLock(serviceId, 'proc-A', STALE_MS)).to.equal(true)
      // second process: fresh lock held by A → refused
      expect(await db.acquireServiceLock(serviceId, 'proc-B', STALE_MS)).to.equal(false)
      // A releasing frees it for B
      await db.releaseServiceLock(serviceId, 'proc-A')
      expect(await db.acquireServiceLock(serviceId, 'proc-B', STALE_MS)).to.equal(true)
      await db.releaseServiceLock(serviceId, 'proc-B')
    })

    it('steals a stale lock (crashed holder) but not a fresh one', async () => {
      const serviceId = `lock-svc-${Date.now()}-b`
      // staleMs = 0 makes A's row instantly stale — simulates a dead process
      expect(await db.acquireServiceLock(serviceId, 'proc-A', STALE_MS)).to.equal(true)
      expect(await db.acquireServiceLock(serviceId, 'proc-B', 0)).to.equal(true)
      // now B's row is fresh: A must not get it back with a normal window
      expect(await db.acquireServiceLock(serviceId, 'proc-A', STALE_MS)).to.equal(false)
      await db.releaseServiceLock(serviceId, 'proc-B')
    })

    it('release is holder-scoped: a stale-steal victim cannot delete the new lock', async () => {
      const serviceId = `lock-svc-${Date.now()}-c`
      expect(await db.acquireServiceLock(serviceId, 'proc-A', STALE_MS)).to.equal(true)
      expect(await db.acquireServiceLock(serviceId, 'proc-B', 0)).to.equal(true) // steal
      // A (which lost the lock) releasing must be a no-op for B's row
      await db.releaseServiceLock(serviceId, 'proc-A')
      expect(await db.isServiceLocked(serviceId, STALE_MS)).to.equal(true)
      await db.releaseServiceLock(serviceId, 'proc-B')
      expect(await db.isServiceLocked(serviceId, STALE_MS)).to.equal(false)
    })

    it('refreshServiceLocks re-stamps a holder’s rows so they stay unstealable', async () => {
      const serviceId = `lock-svc-${Date.now()}-d`
      expect(await db.acquireServiceLock(serviceId, 'proc-A', STALE_MS)).to.equal(true)
      await db.refreshServiceLocks('proc-A')
      // B considers anything older than 5s stale — A's row was just re-stamped
      expect(await db.acquireServiceLock(serviceId, 'proc-B', 5_000)).to.equal(false)
      await db.releaseServiceLock(serviceId, 'proc-A')
    })
  })

  it('inserts and reads back a service job by serviceId', async () => {
    const job = makeServiceJob()
    await db.newServiceJob(job)
    const [found] = await db.getServiceJob(job.serviceId)
    assert(found, 'service job not found')
    expect(found.serviceId).to.equal(job.serviceId)
    expect(found.environment).to.equal('env-a')
    expect(found.userData).to.equal('ENCRYPTED_BLOB')
    expect(found.resources[0]).to.deep.equal({ id: 'cpu', amount: 2 })
  })

  it('filters service jobs by owner', async () => {
    const mine = makeServiceJob({ owner: '0xalice' })
    const theirs = makeServiceJob({ owner: '0xbob' })
    await db.newServiceJob(mine)
    await db.newServiceJob(theirs)
    const aliceJobs = await db.getServiceJob(undefined, '0xalice')
    expect(aliceJobs.every((j) => j.owner === '0xalice')).to.equal(true)
    expect(aliceJobs.find((j) => j.serviceId === mine.serviceId)).to.not.equal(undefined)
  })

  it('updates a service job (status + expiresAt + body)', async () => {
    const job = makeServiceJob()
    await db.newServiceJob(job)
    job.status = ServiceStatusNumber.Stopped
    job.statusText = 'Stopped'
    job.expiresAt = 123456
    const updated = await db.updateServiceJob(job)
    expect(updated).to.equal(1)
    const [found] = await db.getServiceJob(job.serviceId)
    expect(found.status).to.equal(ServiceStatusNumber.Stopped)
    expect(found.expiresAt).to.equal(123456)
  })

  it('getRunningServiceJobs returns only active statuses for the cluster', async () => {
    const running = makeServiceJob({ status: ServiceStatusNumber.Running })
    const starting = makeServiceJob({ status: ServiceStatusNumber.Starting })
    const locking = makeServiceJob({ status: ServiceStatusNumber.Locking })
    const claiming = makeServiceJob({ status: ServiceStatusNumber.Claiming })
    const restarting = makeServiceJob({ status: ServiceStatusNumber.Restarting })
    const error = makeServiceJob({ status: ServiceStatusNumber.Error })
    const stopped = makeServiceJob({ status: ServiceStatusNumber.Stopped })
    // never paid: escrow lock failed outright (all payment fields empty)
    const unpaidError = makeServiceJob({
      status: ServiceStatusNumber.Error,
      payment: {
        chainId: 8996,
        token: '0x123',
        lockTx: '',
        claimTx: '',
        cancelTx: '',
        cost: 5
      }
    })
    // never paid: lock was refunded before being claimed
    const refundedStopped = makeServiceJob({
      status: ServiceStatusNumber.Stopped,
      payment: {
        chainId: 8996,
        token: '0x123',
        lockTx: '0xlock',
        claimTx: '',
        cancelTx: '0xcancel',
        cost: 5
      }
    })
    const otherCluster = makeServiceJob({
      status: ServiceStatusNumber.Running,
      clusterHash: 'other-cluster'
    })
    await db.newServiceJob(running)
    await db.newServiceJob(starting)
    await db.newServiceJob(locking)
    await db.newServiceJob(claiming)
    await db.newServiceJob(restarting)
    await db.newServiceJob(error)
    await db.newServiceJob(stopped)
    await db.newServiceJob(unpaidError)
    await db.newServiceJob(refundedStopped)
    await db.newServiceJob(otherCluster)

    const active = await db.getRunningServiceJobs(CLUSTER_HASH)
    const ids = active.map((j) => j.serviceId)
    expect(ids).to.include(running.serviceId)
    expect(ids).to.include(starting.serviceId)
    // the new start-pipeline states must reserve resources too
    expect(ids).to.include(locking.serviceId)
    expect(ids).to.include(claiming.serviceId)
    // a mid-restart service keeps holding its resources
    expect(ids).to.include(restarting.serviceId)
    // a service whose container died on its own still reserves its resources until
    // restarted or expired
    expect(ids).to.include(error.serviceId)
    // an explicitly-stopped service KEEPS its reservation too: the consumer paid for
    // the whole window and may restart it anytime — only Expired releases resources
    expect(ids).to.include(stopped.serviceId)
    // …but the reservation is tied to PAYMENT: a terminal job whose payment was never
    // claimed (lock failed / refunded) must not squat resources
    expect(ids).to.not.include(unpaidError.serviceId)
    expect(ids).to.not.include(refundedStopped.serviceId)
    expect(ids).to.not.include(otherCluster.serviceId)
  })

  it('getPendingServiceStarts returns mid-start jobs (not Running/terminal) for the cluster', async () => {
    const starting = makeServiceJob({ status: ServiceStatusNumber.Starting })
    const locking = makeServiceJob({ status: ServiceStatusNumber.Locking })
    const claiming = makeServiceJob({ status: ServiceStatusNumber.Claiming })
    const restarting = makeServiceJob({ status: ServiceStatusNumber.Restarting })
    const running = makeServiceJob({ status: ServiceStatusNumber.Running })
    const stopped = makeServiceJob({ status: ServiceStatusNumber.Stopped })
    const otherCluster = makeServiceJob({
      status: ServiceStatusNumber.Starting,
      clusterHash: 'other-cluster'
    })
    await db.newServiceJob(starting)
    await db.newServiceJob(locking)
    await db.newServiceJob(claiming)
    await db.newServiceJob(restarting)
    await db.newServiceJob(running)
    await db.newServiceJob(stopped)
    await db.newServiceJob(otherCluster)

    const pending = await db.getPendingServiceStarts(CLUSTER_HASH)
    const ids = pending.map((j) => j.serviceId)
    expect(ids).to.include(starting.serviceId)
    expect(ids).to.include(locking.serviceId)
    expect(ids).to.include(claiming.serviceId)
    // a crash mid-restart must be orphan-recovered at boot exactly like a crash mid-start
    expect(ids).to.include(restarting.serviceId)
    expect(ids).to.not.include(running.serviceId) // already started
    expect(ids).to.not.include(stopped.serviceId)
    expect(ids).to.not.include(otherCluster.serviceId)
  })

  it('getExpiredServiceJobs returns Running, Error and Stopped jobs past expiry', async () => {
    const expired = makeServiceJob({
      status: ServiceStatusNumber.Running,
      expiresAt: Date.now() - 1000
    })
    const expiredError = makeServiceJob({
      status: ServiceStatusNumber.Error,
      expiresAt: Date.now() - 1000
    })
    const future = makeServiceJob({
      status: ServiceStatusNumber.Running,
      expiresAt: Date.now() + 3600_000
    })
    const expiredStopped = makeServiceJob({
      status: ServiceStatusNumber.Stopped,
      expiresAt: Date.now() - 1000
    })
    const futureStopped = makeServiceJob({
      status: ServiceStatusNumber.Stopped,
      expiresAt: Date.now() + 3600_000
    })
    await db.newServiceJob(expired)
    await db.newServiceJob(expiredError)
    await db.newServiceJob(future)
    await db.newServiceJob(expiredStopped)
    await db.newServiceJob(futureStopped)

    const expiredJobs = await db.getExpiredServiceJobs(CLUSTER_HASH)
    const ids = expiredJobs.map((j) => j.serviceId)
    expect(ids).to.include(expired.serviceId)
    // an abandoned Error'd service must still be swept once past expiresAt, or its
    // reserved resources/ports would leak forever
    expect(ids).to.include(expiredError.serviceId)
    // a Stopped service past its paid window must flip to Expired instead of sitting
    // at Stopped forever (where it would read as restartable)
    expect(ids).to.include(expiredStopped.serviceId)
    expect(ids).to.not.include(future.serviceId)
    expect(ids).to.not.include(futureStopped.serviceId)
  })

  describe('shared resource accounting (compute + service)', () => {
    let engine: SharedAccountingEngine

    before(async () => {
      engine = new SharedAccountingEngine(db)
      engine.setLimits(
        new Map([
          ['cpu', 10],
          ['gpu0', 2]
        ])
      )
      // Clean slate: retire any leftover jobs from earlier tests by marking them Expired —
      // the only status that releases the reservation (Stopped still counts as active).
      const leftovers = await db.getRunningServiceJobs(CLUSTER_HASH)
      for (const j of leftovers) {
        j.status = ServiceStatusNumber.Expired
        await db.updateServiceJob(j)
      }
    })

    it('a running service occupies fungible resources in its own env', async () => {
      await db.newServiceJob(
        makeServiceJob({
          environment: 'env-shared',
          status: ServiceStatusNumber.Running,
          resources: [{ id: 'cpu', amount: 3 }]
        })
      )
      const env = makeEnv('env-shared', [
        { id: 'cpu', kind: 'fungible', total: 10, min: 1, max: 10 } as ComputeResource
      ])
      const used = await engine.getUsedResources(env)
      expect(used.usedResources.cpu).to.equal(3)
    })

    it('fungible usage is NOT counted against a different env', async () => {
      // The cpu service above is bound to 'env-shared'; a different env sees 0 cpu used.
      const otherEnv = makeEnv('env-other', [
        { id: 'cpu', kind: 'fungible', total: 10, min: 1, max: 10 } as ComputeResource
      ])
      const used = await engine.getUsedResources(otherEnv)
      expect(used.usedResources.cpu ?? 0).to.equal(0)
    })

    it('a running service occupies discrete resources GLOBALLY (any env)', async () => {
      await db.newServiceJob(
        makeServiceJob({
          environment: 'env-gpu',
          status: ServiceStatusNumber.Running,
          resources: [{ id: 'gpu0', amount: 1 }]
        })
      )
      // Query a DIFFERENT env: discrete usage is global, so it still shows up.
      const env = makeEnv('env-elsewhere', [
        {
          id: 'gpu0',
          kind: 'discrete',
          type: 'gpu',
          total: 2,
          min: 0,
          max: 2
        } as ComputeResource
      ])
      const used = await engine.getUsedResources(env)
      expect(used.usedResources.gpu0).to.equal(1)
    })

    it('checkIfResourcesAreAvailable blocks a compute request when a service holds the GPU', async () => {
      // gpu0 total:1 in the env, already 1 in use by the service above (global discrete).
      const env = makeEnv('env-elsewhere', [
        {
          id: 'gpu0',
          kind: 'discrete',
          type: 'gpu',
          total: 1,
          min: 0,
          max: 1,
          inUse: 1
        } as ComputeResource
      ])
      let threw = false
      try {
        await engine.checkIfResourcesAreAvailable(
          [{ id: 'gpu0', amount: 1 }],
          env,
          false,
          [env]
        )
      } catch {
        threw = true
      }
      expect(threw).to.equal(true)
    })
  })
})
