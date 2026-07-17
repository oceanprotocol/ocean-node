import { Readable } from 'stream'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeResourceRequest,
  ComputeResourceRequestWithPrice,
  ComputeResourceType,
  ComputeResource,
  ComputeResourcesPricingInfo,
  DBComputeJobPayment,
  DBComputeJob,
  dockerDeviceRequest,
  DBComputeJobMetadata,
  ComputeEnvFees
} from '../../@types/C2D/C2D.js'
import type { ServiceJob } from '../../@types/C2D/ServiceOnDemand.js'
import { C2DClusterType } from '../../@types/C2D/C2D.js'
import { C2DDatabase } from '../database/C2DDatabase.js'
import { Escrow } from '../core/utils/escrow.js'
import { KeyManager } from '../KeyManager/index.js'
import {
  dockerRegistryAuth,
  dockerRegistrysAuth,
  OceanNodeConfig
} from '../../@types/OceanNode.js'
import { ValidateParams } from '../httpRoutes/validateCommands.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { DockerRegistryAuthSchema } from '../../utils/config/schemas.js'
export abstract class C2DEngine {
  private clusterConfig: C2DClusterInfo
  public db: C2DDatabase
  public escrow: Escrow
  public keyManager: KeyManager
  public dockerRegistryAuths: dockerRegistrysAuth
  public config: OceanNodeConfig

  public constructor(
    cluster: C2DClusterInfo,
    db: C2DDatabase,
    escrow: Escrow,
    keyManager: KeyManager,
    config: OceanNodeConfig
  ) {
    this.clusterConfig = cluster
    this.db = db
    this.escrow = escrow
    this.keyManager = keyManager
    this.config = config
    this.dockerRegistryAuths = config?.dockerRegistrysAuth
  }

  getKeyManager(): KeyManager {
    return this.keyManager
  }

  getC2DConfig(): C2DClusterInfo {
    /** Returns cluster config */
    return this.clusterConfig
  }

  getC2DType(): C2DClusterType {
    /** Returns cluster type */
    return this.clusterConfig.type
  }

  // functions which need to be implemented by all engine types
  public abstract getComputeEnvironments(chainId?: number): Promise<ComputeEnvironment[]>

  // overwritten by classes for start actions
  public start(): Promise<void> {
    return null
  }

  // overwritten by classes for cleanup
  public stop(): Promise<void> {
    return null
  }

  // ── Service on Demand (Docker-only for Stage 1; concrete no-ops here) ──
  // Persists the initial Starting record and returns immediately. The heavy lifting
  // (escrow lock/claim, image pull/build, container start) is done asynchronously by
  // processServiceStart(), driven by the engine's background loop.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, require-await
  public async createServiceJob(
    environment: string,
    image: string,
    tag: string | undefined,
    checksum: string | undefined,
    dockerfile: string | undefined,
    additionalDockerFiles: Record<string, string> | undefined,
    dockerCmd: string[] | undefined,
    dockerEntrypoint: string[] | undefined,
    exposedPorts: number[],
    resources: ComputeResourceRequest[],
    duration: number,
    owner: string,
    payment: DBComputeJobPayment,
    serviceId: string,
    userData?: string // ECIES-encrypted; the engine decrypts it transiently into the container env
  ): Promise<ServiceJob | null> {
    return null
  }

  // Background pipeline that advances a Starting service job through locking → image →
  // payment → container → Running. Never throws (terminal failures are persisted as status).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, require-await
  public async processServiceStart(job: ServiceJob): Promise<void> {}

  // onlyIfExpired: expiry-sweep mode — re-validate expiresAt on the fresh row under the
  // lifecycle lock and skip the teardown when the service was extended in the meantime.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, require-await
  public async stopService(
    serviceId: string,
    owner: string,
    onlyIfExpired?: boolean
  ): Promise<ServiceJob | null> {
    return null
  }

  // Runs fn serialized with the engine's per-service lifecycle operations (start
  // pipeline, restart, stop, expiry sweep). Engines without a lock implementation run
  // fn directly; C2DEngineDocker overrides this with its lifecycle lock + DB lease.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async runExclusive<T>(serviceId: string, fn: () => Promise<T>): Promise<T> {
    return await fn()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, require-await
  public async restartService(
    serviceId: string,
    owner: string,
    newUserData?: string,
    newDockerCmd?: string[],
    newDockerEntrypoint?: string[]
  ): Promise<ServiceJob | null> {
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, require-await
  public async getServiceStatus(
    consumerAddress?: string,
    serviceId?: string
  ): Promise<ServiceJob[]> {
    return []
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars, require-await
  public async getServiceStreamableLogs(
    serviceId: string,
    owner: string,
    since?: number
  ): Promise<NodeJS.ReadableStream | null> {
    return null
  }

  // eslint-disable-next-line require-await
  public abstract checkDockerImage(
    image: string,
    encryptedDockerRegistryAuth?: string,
    platform?: any
  ): Promise<ValidateParams>

  public abstract startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: string,
    environment: string,
    owner: string,
    maxJobDuration: number,
    resources: ComputeResourceRequest[],
    payment: DBComputeJobPayment,
    jobId: string,
    metadata?: DBComputeJobMetadata,
    additionalViewers?: string[],
    queueMaxWaitTime?: number,
    encryptedDockerRegistryAuth?: string,
    outputBucketId?: string
  ): Promise<ComputeJob[]>

  public abstract stopComputeJob(
    jobId: string,
    owner: string,
    agreementId?: string
  ): Promise<ComputeJob[]>

  public abstract getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]>

  public abstract getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number,
    offset?: number
  ): Promise<{ stream: Readable; headers: any }>

  public abstract cleanupExpiredStorage(job: DBComputeJob): Promise<boolean>

  public async envExists(
    chainId: number,
    envIdWithHash?: string,
    envIdWithoutHash?: string
  ) {
    try {
      const envs = await this.getComputeEnvironments(chainId)
      for (const c of envs) {
        if (
          (envIdWithHash && c.id === envIdWithHash) ||
          (envIdWithoutHash && this.clusterConfig.hash + '-' + c.id === envIdWithHash)
        ) {
          return true
        }
      }
    } catch (e) {}
    return false
  }

  public async getComputeEnvironment(
    chainId: number,
    envIdWithHash?: string,
    envIdWithoutHash?: string
  ): Promise<ComputeEnvironment> {
    try {
      const envs = await this.getComputeEnvironments(chainId)
      for (const c of envs) {
        if (
          (envIdWithHash && c.id === envIdWithHash) ||
          (envIdWithoutHash && this.clusterConfig.hash + '-' + c.id === envIdWithHash)
        ) {
          return c
        }
      }
    } catch (e) {}
    return null
  }

  public getStreamableLogs(jobId: string): Promise<NodeJS.ReadableStream> {
    throw new Error(`Not implemented for this engine type`)
  }

  protected async getJobEnvironment(job: DBComputeJob): Promise<ComputeEnvironment> {
    const environments: ComputeEnvironment[] = await (
      await this.getComputeEnvironments()
    ).filter((env: ComputeEnvironment) => env.id === job.environment)
    // found it
    if (environments.length === 1) {
      const environment = environments[0]
      return environment
    }
    return null
  }

  /* Returns ComputeResources for a specific resource
   */
  public getMaxMinResource(
    id: ComputeResourceType,
    env: ComputeEnvironment,
    isFree: boolean
  ): ComputeResource {
    const paid = this.getResource(env.resources, id)
    if (!paid) {
      return {
        id,
        total: 0,
        max: 0,
        min: 0
      }
    }
    let free = null
    if (isFree && 'free' in env && 'resources' in env.free) {
      free = this.getResource(env.free.resources, id)
      if (!free) {
        // this resource is not listed under free, so it's not available
        return {
          id,
          total: 0,
          max: 0,
          min: 0
        }
      }
    }
    const total = 'total' in paid ? paid.total : 0
    const max = 'max' in paid ? paid.max : 0
    const min = 'min' in paid ? paid.min : 0
    const ret: ComputeResource = {
      id,
      total: free && 'total' in free ? free.total : total,
      max: free && 'max' in free ? free.max : max,
      min: free && 'min' in free ? free.min : min
    }

    return ret
  }

  // make sure that all requests have cpu, ram, storage
  // eslint-disable-next-line require-await
  public async checkAndFillMissingResources(
    resources: ComputeResourceRequest[],
    env: ComputeEnvironment,
    isFree: boolean
  ): Promise<ComputeResourceRequest[]> {
    if (isFree && !('free' in env)) throw new Error('This env does not support free jobs')
    const properResources: ComputeResourceRequest[] = []
    const elements: string[] = []

    for (const res of isFree ? (env.free?.resources ?? []) : []) elements.push(res.id)
    for (const res of env.resources) if (!elements.includes(res.id)) elements.push(res.id)
    for (const device of elements) {
      let desired = this.getResourceRequest(resources, device)
      const minMax = this.getMaxMinResource(device, env, isFree)
      if (!desired && minMax.min >= 0) {
        // it's required
        desired = minMax.min
      } else {
        if (desired < minMax.min) desired = minMax.min
        if (desired > minMax.max) {
          throw new Error(
            'Not enough ' +
              device +
              ' resources. Requested ' +
              desired +
              ', but max is ' +
              minMax.max
          )
        }
      }
      properResources.push({ id: device, amount: desired })
    }

    this.checkResourceConstraints(properResources, env, isFree)
    return properResources
  }

  protected checkResourceConstraints(
    resources: ComputeResourceRequest[],
    env: ComputeEnvironment,
    isFree: boolean
  ): void {
    // Two-phase on purpose: a later parent's min bump can raise a target past an earlier
    // parent's already-checked max (e.g. gpu1 {cpu min:8} bumping past gpu0 {cpu max:6}),
    // so all floors settle first (direct, then aggregate) and every ceiling is validated
    // afterwards against the final amounts — the outcome no longer depends on the order
    // resources appear in the env definition.
    this.enforceDirectConstraints(resources, env, isFree, 'min')
    this.applyAggregateConstraints(resources, env, isFree)
    this.enforceDirectConstraints(resources, env, isFree, 'max')
  }

  // Non-aggregate constraints, one phase at a time: 'min' raises targets to their floors
  // (throwing when a floor exceeds the target's own max), 'max' rejects ceilings violations.
  protected enforceDirectConstraints(
    resources: ComputeResourceRequest[],
    env: ComputeEnvironment,
    isFree: boolean,
    phase: 'min' | 'max'
  ): void {
    const envResources = isFree ? (env.free?.resources ?? []) : (env.resources ?? [])
    for (const envResource of envResources) {
      if (!envResource.constraints || envResource.constraints.length === 0) continue
      const parentAmount = this.getResourceRequest(resources, envResource.id)
      if (!parentAmount || parentAmount <= 0) continue

      for (const constraint of envResource.constraints) {
        // Aggregate constraints sum across parents — handled in applyAggregateConstraints.
        if (constraint.aggregate) continue
        // perUnit (default true) => RATIO (parentAmount * value); false => absolute FLOOR/ceiling.
        const perUnit = constraint.perUnit !== false
        // A constraint targets either a single resource (`id`) or a group (`type`, aggregated).
        const isGroup = constraint.type !== undefined
        const targetIds = isGroup
          ? this.getGroupResourceIds(env, constraint.type!, isFree)
          : [constraint.id as string]
        const targetLabel = isGroup
          ? `${constraint.type} resources`
          : String(constraint.id)
        const constrainedAmount = isGroup
          ? this.getGroupRequestedAmount(resources, targetIds)
          : (this.getResourceRequest(resources, constraint.id) ?? 0)

        if (phase === 'min' && constraint.min !== undefined) {
          const requiredMin = perUnit ? parentAmount * constraint.min : constraint.min
          if (constrainedAmount < requiredMin) {
            // Aggregate per-job ceiling of the target (single max, or sum of group maxes).
            const targetMax = isGroup
              ? this.getGroupMax(env, targetIds, isFree)
              : this.getMaxMinResource(constraint.id, env, isFree).max
            if (requiredMin > targetMax) {
              throw new Error(
                `Cannot satisfy constraint: ${parentAmount} ${envResource.id} requires at least ${requiredMin} ${targetLabel}, but max is ${targetMax}`
              )
            }
            if (isGroup) {
              this.bumpGroupToFloor(
                resources,
                env,
                targetIds,
                requiredMin - constrainedAmount,
                isFree
              )
            } else {
              this.setResourceAmount(resources, constraint.id, requiredMin)
            }
          }
        }

        if (phase === 'max' && constraint.max !== undefined) {
          const requiredMax = perUnit ? parentAmount * constraint.max : constraint.max
          if (constrainedAmount > requiredMax) {
            throw new Error(
              `Too much ${targetLabel} for ${parentAmount} ${envResource.id}. Max allowed: ${requiredMax}, requested: ${constrainedAmount}`
            )
          }
        }
      }
    }
  }

  // Aggregate constraints (`aggregate: true`) accumulate their per-parent contribution
  // ADDITIVELY into a shared single-`id` target, summed across every requested parent that
  // carries a matching aggregate constraint. This is how per-device GPUs (GPU1, GPU2, each
  // `max:1`) can jointly require e.g. cpu min = Σ(gpuAmount × min) and cpu max = Σ(gpuAmount ×
  // max) — 2 GPUs with a {min:1,max:4} per-GPU rule → cpu in [2, 8]. Non-aggregate constraints
  // keep their independent per-parent behavior (handled in enforceDirectConstraints); this runs
  // between its min and max phases and only ever raises the target's floor.
  protected applyAggregateConstraints(
    resources: ComputeResourceRequest[],
    env: ComputeEnvironment,
    isFree: boolean
  ): void {
    const envResources = isFree ? (env.free?.resources ?? []) : (env.resources ?? [])
    const summedMin = new Map<string, number>()
    const summedMax = new Map<string, number>()
    const hasMax = new Set<string>()

    for (const parent of envResources) {
      if (!parent.constraints || parent.constraints.length === 0) continue
      const parentAmount = this.getResourceRequest(resources, parent.id) ?? 0
      if (parentAmount <= 0) continue
      for (const c of parent.constraints) {
        // aggregate targets a single resource id (validated by schema)
        if (!c.aggregate || c.id === undefined) continue
        const perUnit = c.perUnit !== false
        if (c.min !== undefined) {
          const contrib = perUnit ? parentAmount * c.min : c.min
          summedMin.set(c.id, (summedMin.get(c.id) ?? 0) + contrib)
        }
        if (c.max !== undefined) {
          const contrib = perUnit ? parentAmount * c.max : c.max
          summedMax.set(c.id, (summedMax.get(c.id) ?? 0) + contrib)
          hasMax.add(c.id)
        }
      }
    }

    // min: raise each target up to its summed floor (respecting the target's own max)
    for (const [targetId, requiredMin] of summedMin) {
      const current = this.getResourceRequest(resources, targetId) ?? 0
      if (current < requiredMin) {
        const targetMax = this.getMaxMinResource(targetId, env, isFree).max
        if (requiredMin > targetMax) {
          throw new Error(
            `Cannot satisfy aggregate constraint: requires at least ${requiredMin} ${targetId}, but max is ${targetMax}`
          )
        }
        this.setResourceAmount(resources, targetId, requiredMin)
      }
    }

    // max: reject if a target exceeds its summed ceiling (never auto-reduced)
    for (const targetId of hasMax) {
      const current = this.getResourceRequest(resources, targetId) ?? 0
      const requiredMax = summedMax.get(targetId)
      if (current > requiredMax) {
        throw new Error(
          `Too much ${targetId} for the requested resources. Max allowed: ${requiredMax}, requested: ${current}`
        )
      }
    }
  }

  protected setResourceAmount(
    resources: ComputeResourceRequest[],
    id: ComputeResourceType,
    amount: number
  ): void {
    for (const resource of resources) {
      if (resource.id === id) {
        resource.amount = amount
        return
      }
    }
  }

  // Returns the ids of every resource active in this env (paid or free list) whose `type`
  // matches — the concrete members a `type` group constraint aggregates over.
  protected getGroupResourceIds(
    env: ComputeEnvironment,
    type: string,
    isFree: boolean
  ): string[] {
    const envResources = isFree ? (env.free?.resources ?? []) : (env.resources ?? [])
    return envResources.filter((r) => r.type === type).map((r) => r.id)
  }

  // Sum of requested amounts across a set of resource ids (missing => 0).
  protected getGroupRequestedAmount(
    resources: ComputeResourceRequest[],
    ids: string[]
  ): number {
    let total = 0
    for (const id of ids) total += this.getResourceRequest(resources, id) ?? 0
    return total
  }

  // Aggregate per-job ceiling of a group: sum of each member's max.
  protected getGroupMax(env: ComputeEnvironment, ids: string[], isFree: boolean): number {
    let total = 0
    for (const id of ids) total += this.getMaxMinResource(id, env, isFree).max
    return total
  }

  // Raise members of a `type` group until their combined requested amount grows by `deficit`
  // units. Prefers members with the most availability (lowest inUse), then config order, and
  // never exceeds any member's own max. Relies on checkAndFillMissingResources' pre-fill loop
  // having already inserted an entry for every declared resource, so setResourceAmount always
  // finds its target. inUse here is a point-in-time hint to reduce false deferrals; the
  // authoritative availability gate is checkIfResourcesAreAvailable.
  // NOTE: inUse is read from env.resources (not env.free.resources) on purpose — group
  // constraints target discrete resources (GPUs), whose inUse there is the GLOBAL count
  // (paid + free, across all envs), i.e. the binding availability signal. The free list holds
  // free-only usage and would under-count paid usage of the same physical device.
  protected bumpGroupToFloor(
    resources: ComputeResourceRequest[],
    env: ComputeEnvironment,
    ids: string[],
    deficit: number,
    isFree: boolean
  ): void {
    let remaining = deficit
    const candidates = ids
      .map((id) => {
        const current = this.getResourceRequest(resources, id) ?? 0
        const { max } = this.getMaxMinResource(id, env, isFree)
        const inUse = this.getResource(env.resources, id)?.inUse ?? 0
        return { id, current, headroom: max - current, inUse }
      })
      .filter((c) => c.headroom > 0)
      .sort((a, b) => a.inUse - b.inUse)

    for (const c of candidates) {
      if (remaining <= 0) break
      const bump = Math.min(c.headroom, remaining)
      this.setResourceAmount(resources, c.id, c.current + bump)
      remaining -= bump
    }
  }

  public async getUsedResources(env: ComputeEnvironment): Promise<any> {
    const usedResources: { [x: string]: any } = {}
    const usedFreeResources: { [x: string]: any } = {}
    let jobs: DBComputeJob[] = []
    try {
      jobs = await this.db.getRunningJobs(this.getC2DConfig().hash)
    } catch (e) {
      CORE_LOGGER.error('Failed to get running jobs:' + e.message)
    }

    const envResourceMap = new Map((env.resources || []).map((r) => [r.id, r]))

    let totalJobs = 0
    let totalFreeJobs = 0
    let queuedJobs = 0
    let queuedFreeJobs = 0
    let maxWaitTime = 0
    let maxWaitTimeFree = 0
    let maxRunningTime = 0
    let maxRunningTimeFree = 0

    for (const job of jobs) {
      const isThisEnv = job.environment === env.id
      const isRunning = job.queueMaxWaitTime === 0

      if (isThisEnv) {
        if (isRunning) {
          const timeElapsed = job.buildStartTimestamp
            ? new Date().getTime() / 1000 - Number.parseFloat(job?.buildStartTimestamp)
            : new Date().getTime() / 1000 - Number.parseFloat(job?.algoStartTimestamp)
          totalJobs++
          maxRunningTime += job.maxJobDuration - timeElapsed
          if (job.isFree) {
            totalFreeJobs++
            maxRunningTimeFree += job.maxJobDuration - timeElapsed
          }
        } else {
          queuedJobs++
          maxWaitTime += job.maxJobDuration
          if (job.isFree) {
            queuedFreeJobs++
            maxWaitTimeFree += job.maxJobDuration
          }
        }
      }

      if (isRunning) {
        for (const resource of job.resources) {
          const envRes = envResourceMap.get(resource.id)
          if (envRes) {
            // discrete resources (GPUs, FPGAs, NICs) tracked globally across all envs
            // fungible resources (cpu, ram, disk) are per-env exclusive
            const isGloballyTracked = envRes.kind === 'discrete'
            if (!isGloballyTracked && !isThisEnv) continue
            if (!(resource.id in usedResources)) usedResources[resource.id] = 0
            usedResources[resource.id] += resource.amount
            if (job.isFree) {
              if (!(resource.id in usedFreeResources)) usedFreeResources[resource.id] = 0
              usedFreeResources[resource.id] += resource.amount
            }
          }
        }
      }
    }

    // Fold in on-demand services: they share the same physical resource pool as
    // compute jobs, so a running service must occupy resources too. Services are
    // always paid (no free tier) and always "running" while in the DB's running set,
    // so we only tally their resources — job-slot/queue metrics stay compute-only.
    // Do NOT swallow this failure: getUsedResources feeds the strict resource-availability
    // gate (checkIfResourcesAreAvailable). Under-counting running services would let the
    // engine overcommit shared GPU/CPU/RAM. Let it propagate so the allocation path defers
    // the job (the caller already wraps getComputeEnvironments in try/catch) rather than
    // proceeding with missing service data.
    const serviceJobs: ServiceJob[] = await this.db.getRunningServiceJobs(
      this.getC2DConfig().hash
    )
    for (const svc of serviceJobs) {
      const isThisEnv = svc.environment === env.id
      for (const resource of svc.resources) {
        const envRes = envResourceMap.get(resource.id)
        if (!envRes) continue
        // discrete resources (GPUs, FPGAs, NICs) tracked globally across all envs;
        // fungible resources (cpu, ram, disk) are per-env exclusive.
        const isGloballyTracked = envRes.kind === 'discrete'
        if (!isGloballyTracked && !isThisEnv) continue
        if (!(resource.id in usedResources)) usedResources[resource.id] = 0
        usedResources[resource.id] += resource.amount
      }
    }
    return {
      totalJobs,
      totalFreeJobs,
      usedResources,
      usedFreeResources,
      queuedJobs,
      queuedFreeJobs,
      maxWaitTime,
      maxWaitTimeFree,
      maxRunningTime,
      maxRunningTimeFree
    }
  }

  protected physicalLimits: Map<string, number> = new Map()

  private checkGlobalResourceAvailability(
    allEnvironments: ComputeEnvironment[],
    resourceId: string,
    amount: number
  ) {
    let globalUsed = 0
    let globalTotal = 0
    let discreteInUse: number | undefined
    for (const e of allEnvironments) {
      const res = this.getResource(e.resources, resourceId)
      if (res) {
        globalTotal += res.total || 0
        if (res.kind === 'discrete') {
          // getUsedResources already aggregates discrete inUse globally across all envs,
          // so each env carries the same global value — take the max to avoid N-fold counting.
          discreteInUse = Math.max(discreteInUse ?? 0, res.inUse || 0)
        } else {
          globalUsed += res.inUse || 0
        }
      }
    }
    if (discreteInUse !== undefined) globalUsed += discreteInUse
    const physicalLimit = this.physicalLimits.get(resourceId)
    if (physicalLimit !== undefined && globalTotal > physicalLimit) {
      globalTotal = physicalLimit
    }
    const globalRemainder = globalTotal - globalUsed
    if (globalRemainder < amount) {
      throw new Error(
        `Not enough available ${resourceId} globally (remaining: ${globalRemainder}, requested: ${amount})`
      )
    }
  }

  // overridden by each engine if required
  // eslint-disable-next-line require-await
  public async checkIfResourcesAreAvailable(
    resourcesRequest: ComputeResourceRequest[],
    env: ComputeEnvironment,
    isFree: boolean,
    allEnvironments?: ComputeEnvironment[]
  ) {
    // Filter out resources with amount 0 as they're not actually being requested
    const activeResources = resourcesRequest.filter((r) => r.amount > 0)

    for (const request of activeResources) {
      let envResource = this.getResource(env.resources, request.id)
      if (!envResource) throw new Error(`No such resource ${request.id}`)

      const isFungible = envResource.kind === 'fungible'
      const isShareableDiscrete =
        envResource.kind === 'discrete' && envResource.shareable === true

      // Gate 1 (per-env ceiling) — fungible resources only.
      // envResource.total = env aggregate ceiling (from EnvironmentResourceRef.total).
      if (isFungible && envResource.total - (envResource.inUse ?? 0) < request.amount)
        throw new Error(`Not enough available ${request.id} in this environment`)

      // Gate 2 (engine-wide pool ceiling) — fungible + exclusive discrete.
      // shareable discrete: tracked for visibility but never blocks allocation.
      if (!isShareableDiscrete && allEnvironments) {
        this.checkGlobalResourceAvailability(allEnvironments, request.id, request.amount)
      }

      if (isFree) {
        if (!env.free) throw new Error(`No free resources`)
        envResource = this.getResource(env.free?.resources, request.id)
        if (!envResource) throw new Error(`No such free resource ${request.id}`)
        if (envResource.total - envResource.inUse < request.amount)
          throw new Error(`Not enough available ${request.id} for free`)
      }
    }
    if ('maxJobs' in env && env.maxJobs && env.runningJobs + 1 > env.maxJobs) {
      throw new Error(`Too many running jobs `)
    }
    if (
      isFree &&
      'free' in env &&
      `maxJobs` in env.free &&
      env.free.maxJobs &&
      env.runningfreeJobs + 1 > env.free.maxJobs
    ) {
      throw new Error(`Too many running free jobs `)
    }
  }

  public getResource(resources: ComputeResource[], id: ComputeResourceType) {
    if (!resources) return null
    for (const resource of resources) {
      if (resource.id === id) {
        return resource
      }
    }
    return null
  }

  public getResourceRequest(
    resources: ComputeResourceRequest[],
    id: ComputeResourceType
  ) {
    if (!resources) return null
    for (const resource of resources) {
      if (resource.id === id) {
        return resource.amount
      }
    }
    return null
  }

  public getDockerDeviceRequest(
    requests: ComputeResourceRequest[],
    resources: ComputeResource[]
  ): dockerDeviceRequest[] | null {
    if (!resources) return null

    // Filter out resources with amount 0 as they're not actually being requested
    const activeResources = requests.filter((r) => r.amount > 0)
    const grouped: Record<string, dockerDeviceRequest> = {}

    for (const resource of activeResources) {
      const res = this.getResource(resources, resource.id)
      const init = res?.init?.deviceRequests
      if (!init) continue

      const key = `${init.Driver}-${JSON.stringify(init.Capabilities)}`
      if (!grouped[key]) {
        grouped[key] = {
          Driver: init.Driver,
          Capabilities: init.Capabilities,
          DeviceIDs: [],
          Options: init.Options ?? null,
          Count: undefined
        }
      }

      if (init.DeviceIDs?.length) {
        grouped[key].DeviceIDs!.push(...init.DeviceIDs)
      }
    }

    return Object.values(grouped)
  }

  public getDockerAdvancedConfig(
    requests: ComputeResourceRequest[],
    resources: ComputeResource[]
  ) {
    const ret = {
      Devices: [] as any[],
      GroupAdd: [] as string[],
      SecurityOpt: [] as string[],
      Binds: [] as string[],
      CapAdd: [] as string[],
      CapDrop: [] as string[],
      IpcMode: null as string,
      ShmSize: 0 as number
    }
    // Filter out resources with amount 0 as they're not actually being requested
    const activeResources = requests.filter((r) => r.amount > 0)

    for (const resource of activeResources) {
      const res = this.getResource(resources, resource.id)
      if (res.init && res.init.advanced) {
        for (const [key, value] of Object.entries(res.init.advanced)) {
          switch (key) {
            case 'IpcMode':
              ret.IpcMode = value as string
              break
            case 'ShmSize':
              ret.ShmSize = value as number
              break
            case 'GroupAdd':
              for (const grp of value as string[]) {
                if (!ret.GroupAdd.includes(grp)) ret.GroupAdd.push(grp)
              }
              break
            case 'CapAdd':
              for (const grp of value as string[]) {
                if (!ret.CapAdd.includes(grp)) ret.CapAdd.push(grp)
              }
              break
            case 'CapDrop':
              for (const grp of value as string[]) {
                if (!ret.CapDrop.includes(grp)) ret.CapDrop.push(grp)
              }
              break
            case 'Devices':
              for (const device of value as string[]) {
                if (!ret.Devices.find((d) => d.PathOnHost === device))
                  ret.Devices.push({
                    PathOnHost: device,
                    PathInContainer: device,
                    CgroupPermissions: 'rwm'
                  })
              }
              break
            case 'SecurityOpt':
              for (const [secKeys, secValues] of Object.entries(value))
                if (!ret.SecurityOpt.includes(secKeys + '=' + secValues))
                  ret.SecurityOpt.push(secKeys + '=' + secValues)
              break
            case 'Binds':
              for (const grp of value as string[]) {
                if (!ret.Binds.includes(grp)) ret.Binds.push(grp)
              }
              break
          }
        }
      }
    }
    return ret
  }

  public getEnvPricesForToken(
    env: ComputeEnvironment,
    chainId: number,
    token: string
  ): ComputeResourcesPricingInfo[] {
    if (!env.fees || !(chainId in env.fees) || !env.fees[chainId]) {
      return null
    }
    for (const fee of env.fees[chainId]) {
      // eslint-disable-next-line security/detect-possible-timing-attacks
      if (fee.feeToken === token) {
        return fee.prices
      }
    }

    return null
  }

  public getResourcePrice(
    prices: ComputeResourcesPricingInfo[],
    id: ComputeResourceType
  ) {
    for (const pr of prices) {
      if (pr.id === id) {
        return pr.price
      }
    }
    return 0
  }

  public getTotalCostOfJob(
    resources: ComputeResourceRequestWithPrice[],
    duration: number,
    fee: ComputeEnvFees
  ) {
    let cost: number = 0
    for (const request of resources) {
      const price = fee.prices.find((p) => p.id === request.id)?.price
      if (price) {
        cost += price * request.amount * Math.ceil(duration / 60)
      }
    }
    return cost
  }

  public calculateResourcesCost(
    resourcesRequest: ComputeResourceRequest[],
    env: ComputeEnvironment,
    chainId: number,
    token: string,
    maxJobDuration: number
  ): number | null {
    if (maxJobDuration < env.minJobDuration) maxJobDuration = env.minJobDuration
    const prices = this.getEnvPricesForToken(env, chainId, token)
    if (!prices) return null
    let cost: number = 0
    for (const request of resourcesRequest) {
      const resourcePrice = this.getResourcePrice(prices, request.id)
      cost += resourcePrice * request.amount * Math.ceil(maxJobDuration / 60)
    }
    return cost
  }

  public getDockerRegistryAuth(registry: string): dockerRegistryAuth | null {
    if (!this.dockerRegistryAuths) return null
    if (this.dockerRegistryAuths[registry]) {
      return this.dockerRegistryAuths[registry]
    }
    return null
  }

  public getConfig(): OceanNodeConfig {
    return this.config
  }

  public async checkEncryptedDockerRegistryAuth(
    encryptedDockerRegistryAuth: string
  ): Promise<ValidateParams> {
    let decryptedDockerRegistryAuth: dockerRegistryAuth
    try {
      const decryptedDockerRegistryAuthBuffer = await this.keyManager.decrypt(
        Uint8Array.from(Buffer.from(encryptedDockerRegistryAuth, 'hex')),
        EncryptMethod.ECIES
      )

      // Convert decrypted buffer to string and parse as JSON
      const decryptedDockerRegistryAuthString =
        decryptedDockerRegistryAuthBuffer.toString()

      decryptedDockerRegistryAuth = JSON.parse(decryptedDockerRegistryAuthString)
    } catch (error: any) {
      const errorMessage = `Invalid encryptedDockerRegistryAuth: failed to parse JSON - ${error?.message || String(error)}`
      CORE_LOGGER.error(errorMessage)
      return {
        valid: false,
        reason: errorMessage,
        status: 400
      }
    }

    // Validate using schema - ensures either auth or username+password are provided
    const validationResult = DockerRegistryAuthSchema.safeParse(
      decryptedDockerRegistryAuth
    )
    if (!validationResult.success) {
      const errorMessageValidation = validationResult.error.errors
        .map((err) => err.message)
        .join('; ')
      const errorMessage = `Invalid encryptedDockerRegistryAuth: ${errorMessageValidation}`
      CORE_LOGGER.error(errorMessage)
      return {
        valid: false,
        reason: errorMessage,
        status: 400
      }
    }
    return {
      valid: true,
      reason: null,
      status: 200
    }
  }
}
