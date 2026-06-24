/* eslint-disable security/detect-non-literal-fs-filename */
import { Readable, PassThrough } from 'stream'
import path from 'path'
import {
  C2DStatusNumber,
  C2DStatusText,
  DBComputeJobMetadata
} from '../../@types/C2D/C2D.js'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeOutput,
  ComputeAsset,
  ComputeJob,
  DBComputeJob,
  DBComputeJobPayment,
  ComputeResult,
  RunningPlatform,
  ComputeEnvFeesStructure,
  ComputeResourceRequest,
  ComputeEnvFees,
  ComputeResource,
  ComputeResourceKind,
  C2DEnvironmentConfig,
  ComputeResourcesPricingInfo
} from '../../@types/C2D/C2D.js'
import { BASE_CHAIN_ID, USDC_TOKEN_ADDRESS_BASE } from '../../utils/config.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DDatabase } from '../database/C2DDatabase.js'
import { Escrow } from '../core/utils/escrow.js'
import { create256Hash } from '../../utils/crypt.js'
import { Storage } from '../storage/index.js'
import Dockerode from 'dockerode'
import type { ContainerCreateOptions, HostConfig, VolumeCreateOptions } from 'dockerode'
import * as tar from 'tar'
import * as tarStream from 'tar-stream'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  statSync,
  statfsSync,
  createReadStream
} from 'fs'
import { pipeline } from 'node:stream/promises'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { AssetUtils } from '../../utils/asset.js'
import { FindDdoHandler } from '../core/handler/ddoHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { KeyManager } from '../KeyManager/index.js'
import { decryptFilesObject, omitDBComputeFieldsFromComputeJob } from './index.js'
import { ValidateParams } from '../httpRoutes/validateCommands.js'
import { Service } from '@oceanprotocol/ddo-js'
import { getOceanTokenAddressForChain } from '../../utils/address.js'
import { dockerRegistryAuth, OceanNodeConfig } from '../../@types/OceanNode.js'
import {
  BaseFileObject,
  EncryptMethod,
  isPersistentStorageType
} from '../../@types/fileObject.js'
import { getAddress, ZeroAddress } from 'ethers'
import {
  ServiceStatusNumber,
  ServiceStatusText
} from '../../@types/C2D/ServiceOnDemand.js'
import type { ServiceJob, ServiceEndpoint } from '../../@types/C2D/ServiceOnDemand.js'
import { resolveServiceImage } from './serviceResourceMatching.js'
import {
  allocateHostPort,
  releaseHostPort,
  seedAllocatedPorts,
  userDataToEnv,
  decryptUserData
} from '../core/service/utils.js'

const C2D_CONTAINER_UID = 1000
const C2D_CONTAINER_GID = 1000

const trivyImage = 'aquasec/trivy:0.69.3' // Use pinned versions for safety

export class C2DEngineDocker extends C2DEngine {
  private envs: ComputeEnvironment[] = []

  public docker: Dockerode
  private cronTimer: any
  private cronTime: number = 2000
  private jobImageSizes: Map<string, number> = new Map()
  private isInternalLoopRunning: boolean = false
  private imageCleanupTimer: NodeJS.Timeout | null = null
  private paymentClaimTimer: NodeJS.Timeout | null = null
  private scanDBUpdateTimer: NodeJS.Timeout | null = null
  private static DEFAULT_DOCKER_REGISTRY = 'https://registry-1.docker.io'
  private retentionDays: number
  private cleanupInterval: number
  private paymentClaimInterval: number
  private scanImages: boolean
  private scanImageDBUpdateInterval: number
  private trivyCachePath: string
  private cpuAllocations: Map<string, number[]> = new Map()
  private envCpuCoresMap: Map<string, number[]> = new Map()
  private activeBuildAborts: Map<string, AbortController> = new Map()

  public constructor(
    clusterConfig: C2DClusterInfo,
    db: C2DDatabase,
    escrow: Escrow,
    keyManager: KeyManager,
    config: OceanNodeConfig
  ) {
    super(clusterConfig, db, escrow, keyManager, config)

    this.docker = null
    if (clusterConfig.connection.socketPath) {
      try {
        this.docker = new Dockerode({ socketPath: clusterConfig.connection.socketPath })
      } catch (e) {
        CORE_LOGGER.error('Could not create Docker container: ' + e.message)
      }
    }
    this.retentionDays = clusterConfig.connection.imageRetentionDays || 7
    this.cleanupInterval = clusterConfig.connection.imageCleanupInterval
    this.paymentClaimInterval = clusterConfig.connection.paymentClaimInterval || 3600 // 1 hour
    this.scanImages = clusterConfig.connection.scanImages || false // default is not to scan images for now, until it's prod ready
    this.scanImageDBUpdateInterval = clusterConfig.connection.scanImageDBUpdateInterval

    if (
      clusterConfig.connection.protocol &&
      clusterConfig.connection.host &&
      clusterConfig.connection.port
    ) {
      try {
        this.docker = new Dockerode({
          protocol: clusterConfig.connection.protocol,
          host: clusterConfig.connection.host,
          port: clusterConfig.connection.port
        })
      } catch (e) {
        CORE_LOGGER.error('Could not create Docker container: ' + e.message)
      }
    }
    // trivy cache is the same for all engines
    this.trivyCachePath = path.join(
      process.cwd(),
      this.getC2DConfig().tempFolder,
      'trivy_cache'
    )
    try {
      if (!existsSync(this.getStoragePath()))
        mkdirSync(this.getStoragePath(), { recursive: true })
      if (!existsSync(this.trivyCachePath))
        mkdirSync(this.trivyCachePath, { recursive: true })
    } catch (e) {
      CORE_LOGGER.error(
        'Could not create Docker container temporary folders: ' + e.message
      )
    }

    // envs are build on start function
  }

  private processFeesForEnvironment(
    rawFees: ComputeEnvFeesStructure | undefined,
    supportedChains: number[]
  ): ComputeEnvFeesStructure | null {
    if (!rawFees || Object.keys(rawFees).length === 0) return null
    let fees: ComputeEnvFeesStructure = null
    for (const feeChain of Object.keys(rawFees)) {
      if (!supportedChains.includes(parseInt(feeChain))) continue
      if (fees === null) fees = {}
      if (!(feeChain in fees)) fees[feeChain] = []
      const tmpFees: ComputeEnvFees[] = []
      for (const feeEntry of rawFees[feeChain]) {
        if (!feeEntry.prices || feeEntry.prices.length === 0) {
          CORE_LOGGER.error(
            `Unable to find prices for fee ${JSON.stringify(feeEntry)} on chain ${feeChain}`
          )
          continue
        }
        if (!feeEntry.feeToken) {
          const tokenAddress = getOceanTokenAddressForChain(parseInt(feeChain))
          if (tokenAddress) {
            feeEntry.feeToken = tokenAddress
            tmpFees.push(feeEntry)
          } else {
            CORE_LOGGER.error(
              `Unable to find Ocean token address for chain ${feeChain} and no custom token provided`
            )
          }
        } else {
          tmpFees.push(feeEntry)
        }
      }
      fees[feeChain] = tmpFees
    }
    return fees
  }

  public getStoragePath(): string {
    return this.getC2DConfig().tempFolder + this.getC2DConfig().hash
  }

  private resolveResourceKind(res: ComputeResource): ComputeResourceKind {
    if (res.kind) return res.kind
    if (res.init) return 'discrete'
    return 'fungible'
  }

  private resolveConnectionResourcePool(
    sysinfo: any,
    configResources: ComputeResource[] | undefined
  ): Map<string, ComputeResource> {
    const pool = new Map<string, ComputeResource>()

    const physicalCpu = sysinfo.NCPU
    const physicalRamGB = Math.floor(sysinfo.MemTotal / 1024 / 1024 / 1024)
    const physicalDiskGB = this.physicalLimits.get('disk') || 0

    pool.set('cpu', {
      id: 'cpu',
      type: 'cpu',
      kind: 'fungible',
      total: physicalCpu,
      max: physicalCpu,
      min: 1
    })
    pool.set('ram', {
      id: 'ram',
      type: 'ram',
      kind: 'fungible',
      total: physicalRamGB,
      max: physicalRamGB,
      min: 1
    })
    pool.set('disk', {
      id: 'disk',
      type: 'disk',
      kind: 'fungible',
      total: physicalDiskGB,
      max: physicalDiskGB,
      min: 0
    })

    for (const res of configResources ?? []) {
      const resolvedKind = this.resolveResourceKind(res)
      if (['cpu', 'ram', 'disk'].includes(res.id)) {
        const base = pool.get(res.id)
        const cap = this.physicalLimits.get(res.id) ?? res.total
        if (res.total > cap)
          CORE_LOGGER.warn(
            `Resource "${res.id}": configured total ${res.total} exceeds physical ${cap}, capping`
          )
        if (res.total !== undefined) base.total = Math.min(res.total, cap)
        base.max = res.max !== undefined ? Math.min(res.max, base.total) : base.total
        if (res.min !== undefined) base.min = res.min
        if (res.constraints !== undefined)
          base.constraints = structuredClone(res.constraints)
      } else {
        // Warn if a GPU resource has multiple DeviceIDs — each physical GPU should be its own resource.
        if (res.init?.deviceRequests?.DeviceIDs?.length > 1) {
          CORE_LOGGER.warn(
            `Resource "${res.id}": DeviceIDs has ${res.init.deviceRequests.DeviceIDs.length} entries. ` +
              `Each physical GPU should be its own resource with a single DeviceID.`
          )
        }
        const custom: ComputeResource = {
          ...res,
          kind: resolvedKind,
          max: res.max ?? res.total,
          min: res.min ?? 0
        }
        pool.set(res.id, custom)
        // Register in physicalLimits so checkGlobalResourceAvailability caps correctly.
        this.physicalLimits.set(res.id, res.total)
      }
    }
    return pool
  }

  private resolveEnvironmentResources(
    envDef: C2DEnvironmentConfig,
    pool: Map<string, ComputeResource>
  ): ComputeResource[] {
    const refs = envDef.resources || []
    const result: ComputeResource[] = []
    for (const ref of refs) {
      const poolRes = pool.get(ref.id)
      if (!poolRes) {
        CORE_LOGGER.warn(`resource "${ref.id}" not in pool, skipping`)
        continue
      }
      const resolved: ComputeResource = {
        ...poolRes,
        init: poolRes.init ? structuredClone(poolRes.init) : undefined,
        constraints: poolRes.constraints
          ? structuredClone(poolRes.constraints)
          : undefined
      }

      if (poolRes.kind === 'fungible') {
        resolved.total =
          ref.total !== undefined ? Math.min(ref.total, poolRes.total) : poolRes.total
      }
      if (ref.max !== undefined) resolved.max = Math.min(ref.max, resolved.total)
      if (ref.min !== undefined) resolved.min = ref.min
      if (ref.constraints !== undefined)
        resolved.constraints = structuredClone(ref.constraints)
      result.push(resolved)
    }
    return result
  }

  private createBenchmarkEnvironment(sysinfo: any, envConfig: any): void {
    // Collect all discrete accelerators (GPUs, FPGAs, etc.) from the connection-level resources.
    const discreteResources: ComputeResource[] = (envConfig.resources ?? []).filter(
      (res: ComputeResource) => this.resolveResourceKind(res) === 'discrete'
    )

    const benchmarkPrices: ComputeResourcesPricingInfo[] =
      discreteResources.length > 0 ? [{ id: discreteResources[0].id, price: 1 }] : []

    const benchmarkFees: ComputeEnvFeesStructure = {
      [BASE_CHAIN_ID]: [{ feeToken: USDC_TOKEN_ADDRESS_BASE, prices: benchmarkPrices }]
    }

    // Benchmark env uses resource refs: cpu/ram/disk are auto-detected; discrete accelerators listed by id.
    const gpuRefs = discreteResources.map((r) => ({ id: r.id }))
    const benchmarkEnv: C2DEnvironmentConfig = {
      description: 'Auto-generated benchmark environment',
      storageExpiry: 604800,
      maxJobDuration: 180,
      minJobDuration: 0,
      resources: [{ id: 'cpu' }, { id: 'ram' }, { id: 'disk' }, ...gpuRefs],
      access: {
        addresses: [],
        accessLists: [
          { [BASE_CHAIN_ID]: [getAddress('0xcb7Db55Ca9Aa9C3b25F5Bc266da63317fa02086a')] }
        ]
      },
      fees: benchmarkFees,
      enableNetwork: true
    }

    envConfig.environments.push(benchmarkEnv)
  }

  public override async start() {
    const config = this.getConfig()
    const envConfig = await this.getC2DConfig().connection
    if (!envConfig?.environments?.length) {
      CORE_LOGGER.warn(
        `Skipping C2D Engine ${this.getC2DConfig().hash}: no environments configured`
      )
      return
    }
    let sysinfo = null
    try {
      sysinfo = await this.docker.info()
    } catch (e) {
      CORE_LOGGER.error('Could not get docker info: ' + e.message)
      // since we cannot connect to docker, we cannot start the engine -> no envs
      return
    }

    this.physicalLimits.set('cpu', sysinfo.NCPU)
    this.physicalLimits.set('ram', Math.floor(sysinfo.MemTotal / 1024 / 1024 / 1024))
    try {
      const diskStats = statfsSync(this.getC2DConfig().tempFolder)
      const diskGB = Math.floor((diskStats.bsize * diskStats.blocks) / 1024 / 1024 / 1024)
      this.physicalLimits.set('disk', diskGB)
    } catch (e) {
      CORE_LOGGER.warn('Could not detect physical disk size: ' + e.message)
    }

    // Determine supported chains
    const supportedChains: number[] = []
    if (config.supportedNetworks) {
      for (const chain of Object.keys(config.supportedNetworks)) {
        supportedChains.push(parseInt(chain))
      }
    }

    const platform: RunningPlatform = {
      architecture: sysinfo.Architecture,
      os: sysinfo.OSType
    }
    const consumerAddress = this.getKeyManager().getEthAddress()

    if (config.enableBenchmark) {
      if (supportedChains.includes(parseInt(BASE_CHAIN_ID))) {
        this.createBenchmarkEnvironment(sysinfo, envConfig)
      } else {
        CORE_LOGGER.warn(
          `Skipping benchmark environment: Base chain (${BASE_CHAIN_ID}) is not in supportedNetworks`
        )
      }
    }

    const connectionPool = this.resolveConnectionResourcePool(
      sysinfo,
      envConfig.resources
    )

    for (let envIdx = 0; envIdx < envConfig.environments.length; envIdx++) {
      const envDef: C2DEnvironmentConfig = envConfig.environments[envIdx]

      const fees = this.processFeesForEnvironment(envDef.fees, supportedChains)
      const envResources = this.resolveEnvironmentResources(envDef, connectionPool)

      const env: ComputeEnvironment = {
        id: '',
        runningJobs: 0,
        consumerAddress,
        platform,
        access: envDef.access || { addresses: [], accessLists: null },
        fees,
        resources: envResources,
        queuedJobs: 0,
        queuedFreeJobs: 0,
        queMaxWaitTime: 0,
        queMaxWaitTimeFree: 0,
        runMaxWaitTime: 0,
        runMaxWaitTimeFree: 0,
        enableNetwork: envDef.enableNetwork,
        features: {
          computeJobs: envDef.features?.computeJobs ?? true,
          services: envDef.features?.services ?? true
        }
      }

      if (envDef.storageExpiry !== undefined) env.storageExpiry = envDef.storageExpiry
      if (envDef.minJobDuration !== undefined) env.minJobDuration = envDef.minJobDuration
      if (envDef.maxJobDuration !== undefined) env.maxJobDuration = envDef.maxJobDuration
      if (envDef.maxJobs !== undefined) env.maxJobs = envDef.maxJobs
      if (envDef.description !== undefined) env.description = envDef.description

      // Free tier config for this environment
      if (envDef.free) {
        env.free = {
          access: envDef.free.access || { addresses: [], accessLists: null }
        }
        if (envDef.free.storageExpiry !== undefined)
          env.free.storageExpiry = envDef.free.storageExpiry
        if (envDef.free.minJobDuration !== undefined)
          env.free.minJobDuration = envDef.free.minJobDuration
        if (envDef.free.maxJobDuration !== undefined)
          env.free.maxJobDuration = envDef.free.maxJobDuration
        if (envDef.free.maxJobs !== undefined) env.free.maxJobs = envDef.free.maxJobs
        if (envDef.free.allowImageBuild !== undefined)
          env.free.allowImageBuild = envDef.free.allowImageBuild
        // Resolve free resource refs → full ComputeResource[] using the same connection pool.
        if (envDef.free.resources) {
          env.free.resources = this.resolveEnvironmentResources(
            { resources: envDef.free.resources } as C2DEnvironmentConfig,
            connectionPool
          )
        }
      }

      const envIdSuffix = envDef.id || String(envIdx)
      env.id =
        this.getC2DConfig().hash +
        '-' +
        create256Hash(JSON.stringify(env.fees) + envIdSuffix)

      this.envs.push(env)
      CORE_LOGGER.info(
        `Engine ${this.getC2DConfig().hash}: created environment ${env.id} (index=${envIdx}, resources=${envResources.map((r) => r.id).join(',')})`
      )
    }

    // CPU affinity: all environments share the full physical core pool.
    // allocateCpus() dynamically assigns free cores per job across all envs.
    const physicalCpuCount = this.physicalLimits.get('cpu') || 0
    const allCores = Array.from({ length: physicalCpuCount }, (_, i) => i)
    for (const env of this.envs) {
      const cpuRes = this.getResource(env.resources ?? [], 'cpu')
      if (cpuRes && cpuRes.total > 0) {
        this.envCpuCoresMap.set(env.id, allCores)
        CORE_LOGGER.info(
          `CPU affinity: environment ${env.id} shares pool of ${allCores.length} cores`
        )
      }
    }

    // Rebuild CPU allocations from running containers (handles node restart)
    await this.rebuildCpuAllocations()

    // Re-seed the in-memory allocated-host-port set from running service jobs (handles node restart)
    await seedAllocatedPorts(this.db, this.getC2DConfig().hash).catch((e) => {
      CORE_LOGGER.warn(`Could not seed allocated service ports: ${e.message}`)
    })

    // only now set the timer
    if (!this.cronTimer) {
      this.setNewTimer()
    }
    this.startCrons()
  }

  public startCrons() {
    if (!this.docker) {
      CORE_LOGGER.debug('Docker not available, skipping crons')
      return
    }

    // Start image cleanup timer
    if (this.cleanupInterval) {
      if (this.imageCleanupTimer) {
        return // Already running
      }
      // Run initial cleanup after a short delay
      setTimeout(() => {
        this.cleanupOldImages().catch((e) => {
          CORE_LOGGER.error(`Initial image cleanup failed: ${e.message}`)
        })
      }, 60000) // Wait 1 minute after start

      // Set up periodic cleanup
      this.imageCleanupTimer = setInterval(() => {
        this.cleanupOldImages().catch((e) => {
          CORE_LOGGER.error(`Periodic image cleanup failed: ${e.message}`)
        })
      }, this.cleanupInterval * 1000)

      CORE_LOGGER.info(
        `Image cleanup timer started (interval: ${this.cleanupInterval / 60} minutes)`
      )
    }
    // start payments cron
    if (this.paymentClaimInterval) {
      if (this.paymentClaimTimer) {
        return // Already running
      }

      // Run initial cleanup after a short delay
      setTimeout(() => {
        this.claimPayments().catch((e) => {
          CORE_LOGGER.error(`Initial payments claim failed: ${e.message}`)
        })
      }, 60000) // Wait 1 minute after start

      // Set up periodic cleanup
      this.paymentClaimTimer = setInterval(() => {
        this.claimPayments().catch((e) => {
          CORE_LOGGER.error(`Periodic payments claim failed: ${e.message}`)
        })
      }, this.paymentClaimInterval * 1000)

      CORE_LOGGER.info(
        `Payments claim timer started (interval: ${this.paymentClaimInterval / 60} minutes)`
      )
    }
    // scan db updater cron
    if (this.scanImageDBUpdateInterval) {
      if (this.scanDBUpdateTimer) {
        return // Already running
      }

      // Run initial db cache
      setTimeout(() => {
        this.scanDBUpdate().catch((e) => {
          CORE_LOGGER.error(`scan DB Update Initial failed: ${e.message}`)
        })
      }, 30000) // Wait 30 seconds

      // Set up periodic cleanup
      this.scanDBUpdateTimer = setInterval(() => {
        this.scanDBUpdate().catch((e) => {
          CORE_LOGGER.error(`Periodic scan DB update failed: ${e.message}`)
        })
      }, this.scanImageDBUpdateInterval * 1000)

      CORE_LOGGER.info(
        `scan DB update timer started (interval: ${this.scanImageDBUpdateInterval / 60} minutes)`
      )
    }
  }

  public override stop(): Promise<void> {
    // Clear the timer and reset the flag
    if (this.cronTimer) {
      clearTimeout(this.cronTimer)
      this.cronTimer = null
    }
    this.isInternalLoopRunning = false
    // Stop image cleanup timer
    if (this.imageCleanupTimer) {
      clearInterval(this.imageCleanupTimer)
      this.imageCleanupTimer = null
      CORE_LOGGER.debug('Image cleanup timer stopped')
    }
    if (this.paymentClaimTimer) {
      clearInterval(this.paymentClaimTimer)
      this.paymentClaimTimer = null
      CORE_LOGGER.debug('Payment claim timer stopped')
    }
    return Promise.resolve()
  }

  public async updateImageUsage(image: string): Promise<void> {
    try {
      await this.db.updateImage(image)
    } catch (e) {
      CORE_LOGGER.error(`Failed to update image usage for ${image}: ${e.message}`)
    }
  }

  private async claimPayments(): Promise<void> {
    const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
    const envs: string[] = []
    const envsChains: string[] = []
    // Group jobs by operation type and chain for batch processing
    const jobsToClaim: Array<{
      job: DBComputeJob
      cost: number
      proof: string
    }> = []
    const jobsToCancel: DBComputeJob[] = []
    const jobsWithoutLock: DBComputeJob[] = []

    for (const env of this.envs) {
      envs.push(env.id)
      for (const chain in env.fees) {
        if (!envsChains.includes(chain)) envsChains.push(chain)
      }
    }

    // get all jobs that needs to be paid
    const jobs = await this.db.getJobsByStatus(envs, [
      C2DStatusNumber.AlgorithmFailed,
      C2DStatusNumber.DiskQuotaExceeded,
      C2DStatusNumber.ResultsFetchFailed,
      C2DStatusNumber.ResultsUploadFailed,
      C2DStatusNumber.JobSettle
    ])
    CORE_LOGGER.info(`ClaimPayments:  Got ${jobs.length} jobs to check`)
    if (jobs.length > 0) {
      const providerAddress = this.getKeyManager().getEthAddress()
      const chains: Set<number> = new Set()
      // get all unique chains
      for (const job of jobs) {
        if (job.payment && job.payment.token) {
          chains.add(job.payment.chainId)
        }
      }

      // Get all locks for all chains
      const locks: any[] = []
      for (const chain of chains) {
        try {
          const contractLocks = await this.escrow.getLocks(
            chain,
            ZeroAddress,
            ZeroAddress,
            providerAddress
          )
          if (contractLocks) {
            locks.push(...contractLocks)
          }
        } catch (e) {
          CORE_LOGGER.error(`Failed to get locks for chain ${chain}: ${e.message}`)
        }
      }

      // Process each job to determine what operation is needed
      let duration
      for (const job of jobs) {
        // Calculate algo duration
        duration = parseFloat(job.algoStopTimestamp) - parseFloat(job.algoStartTimestamp)
        duration += this.getValidBuildDurationSeconds(job)

        // Free jobs or jobs without payment info - mark as finished
        if (job.isFree || !job.payment) {
          jobsWithoutLock.push(job)
          continue
        }

        // Find matching lock
        const lock = locks.find(
          (lock) => BigInt(lock.jobId.toString()) === BigInt(job.jobIdHash)
        )

        if (!lock) {
          // No lock found, mark as finished
          jobsWithoutLock.push(job)
          continue
        }

        // Check if lock is expired
        const lockExpiry = BigInt(lock.expiry.toString())
        if (currentTimestamp > lockExpiry) {
          // Lock expired, cancel it
          jobsToCancel.push(job)
          continue
        }

        // Get environment to calculate cost
        const env = await this.getComputeEnvironment(job.payment.chainId, job.environment)

        if (!env) {
          CORE_LOGGER.warn(
            `Environment not found for job ${job.jobId}, skipping payment claim`
          )
          continue
        }

        let minDuration = Math.abs(duration)
        if (minDuration > job.maxJobDuration) {
          minDuration = job.maxJobDuration
        }
        if (
          `minJobDuration` in env &&
          env.minJobDuration &&
          minDuration < env.minJobDuration
        ) {
          minDuration = env.minJobDuration
        }

        if (minDuration > 0) {
          // We need to claim payment
          const fee = env.fees?.[job.payment.chainId]?.find(
            (fee) => fee.feeToken === job.payment.token
          )

          if (!fee) {
            CORE_LOGGER.warn(
              `Fee not found for job ${job.jobId}, token ${job.payment.token}, skipping`
            )
            continue
          }

          const cost = this.getTotalCostOfJob(job.resources, minDuration, fee)
          const proof = JSON.stringify(omitDBComputeFieldsFromComputeJob(job))
          jobsToClaim.push({ job, cost, proof })
        } else {
          // No payment due, cancel the lock
          jobsToCancel.push(job)
        }
      }

      // Batch process claims by chain
      const claimsByChain = new Map<
        number,
        Array<{ job: DBComputeJob; cost: number; proof: string }>
      >()
      for (const claim of jobsToClaim) {
        const { chainId } = claim.job.payment!
        if (!claimsByChain.has(chainId)) {
          claimsByChain.set(chainId, [])
        }
        claimsByChain.get(chainId)!.push(claim)
      }

      // Process batch claims
      for (const [chainId, claims] of claimsByChain.entries()) {
        if (claims.length === 0) continue

        try {
          const jobs = claims.map((c) => c.job)
          const tokens = jobs.map((j) => j.payment!.token)
          const payers = jobs.map((j) => j.owner)
          const amounts = claims.map((c) => c.cost)
          const proofs = claims.map((c) => c.proof)

          const txId = await this.escrow.claimLocks(
            chainId,
            jobs.map((j) => j.jobId),
            tokens,
            payers,
            amounts,
            proofs
          )
          if (txId) {
            // Update all jobs with the transaction ID
            for (const claim of claims) {
              if (claim.job.payment) {
                claim.job.payment.claimTx = txId
                claim.job.payment.cost = claim.cost
              }
              claim.job.status = C2DStatusNumber.JobFinished
              claim.job.statusText = C2DStatusText.JobFinished
              await this.db.updateJob(claim.job)
            }
            CORE_LOGGER.info(
              `Successfully claimed ${claims.length} locks in batch transaction ${txId}`
            )
          }
        } catch (e) {
          CORE_LOGGER.error(
            `Failed to batch claim locks for chain ${chainId}: ${e.message}`
          )
          // Fallback to individual processing on batch failure
          for (const claim of claims) {
            try {
              const txId = await this.escrow.claimLock(
                chainId,
                claim.job.jobId,
                claim.job.payment!.token,
                claim.job.owner,
                claim.cost,
                claim.proof
              )
              if (txId) {
                if (claim.job.payment) {
                  claim.job.payment.claimTx = txId
                  claim.job.payment.cost = claim.cost
                }
                claim.job.status = C2DStatusNumber.JobFinished
                claim.job.statusText = C2DStatusText.JobFinished
                await this.db.updateJob(claim.job)
              }
            } catch (err) {
              CORE_LOGGER.error(
                `Failed to claim lock for job ${claim.job.jobId}: ${err.message}`
              )
            }
          }
        }
      }

      // Batch process cancellations by chain
      const cancellationsByChain = new Map<number, DBComputeJob[]>()
      for (const job of jobsToCancel) {
        const { chainId } = job.payment!
        if (!cancellationsByChain.has(chainId)) {
          cancellationsByChain.set(chainId, [])
        }
        cancellationsByChain.get(chainId)!.push(job)
      }

      // Process batch cancellations
      for (const [chainId, jobsToCancelBatch] of cancellationsByChain.entries()) {
        if (jobsToCancelBatch.length === 0) continue

        try {
          const jobIds = jobsToCancelBatch.map((j) => j.jobId)
          const tokens = jobsToCancelBatch.map((j) => j.payment!.token)
          const payers = jobsToCancelBatch.map((j) => j.owner)

          const txId = await this.escrow.cancelExpiredLocks(
            chainId,
            jobIds,
            tokens,
            payers
          )

          if (txId) {
            // Update all jobs
            for (const job of jobsToCancelBatch) {
              if (job.payment) job.payment.cancelTx = txId
              job.status = C2DStatusNumber.JobFinished
              job.statusText = C2DStatusText.JobFinished
              await this.db.updateJob(job)
            }
            CORE_LOGGER.info(
              `Successfully cancelled ${jobsToCancelBatch.length} expired locks in batch transaction ${txId}`
            )
          }
        } catch (e) {
          CORE_LOGGER.error(
            `Failed to batch cancel locks for chain ${chainId}: ${e.message}`
          )
          // Fallback to individual processing on batch failure
          for (const job of jobsToCancelBatch) {
            try {
              const txId = await this.escrow.cancelExpiredLock(
                chainId,
                job.jobId,
                job.payment!.token,
                job.owner
              )
              if (txId) {
                if (job.payment) job.payment.cancelTx = txId
                job.status = C2DStatusNumber.JobFinished
                job.statusText = C2DStatusText.JobFinished
                await this.db.updateJob(job)
              }
            } catch (err) {
              CORE_LOGGER.error(
                `Failed to cancel lock for job ${job.jobId}: ${err.message}`
              )
            }
          }
        }
      }

      // Mark jobs without locks as finished
      for (const job of jobsWithoutLock) {
        job.status = C2DStatusNumber.JobFinished
        job.statusText = C2DStatusText.JobFinished
        if (job.payment) {
          job.payment.cancelTx = 'nolock'
          job.payment.claimTx = 'nolock'
        }
        await this.db.updateJob(job)
      }
    }
    // force clean of locks without jobs
    // ideally, we should never have locks without jobs in db
    // (handled above). This means somehow that db got deleted
    for (const chain of envsChains) {
      this.cleanUpUnknownLocks(chain, currentTimestamp)
    }
  }

  private async cleanUpUnknownLocks(chain: string, currentTimestamp: bigint) {
    try {
      const nodeAddress = this.getKeyManager().getEthAddress()
      const jobIds: any[] = []
      const tokens: string[] = []
      const payer: string[] = []

      const balocks = await this.escrow.getLocks(
        parseInt(chain),
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000',
        nodeAddress
      )
      if (!balocks || balocks.length === 0) {
        CORE_LOGGER.warn(`Could not find any locks for chain ${chain}, skipping cleanup`)
        return
      }
      for (const lock of balocks) {
        const lockExpiry = BigInt(lock.expiry.toString())
        if (currentTimestamp > lockExpiry) {
          jobIds.push(lock.jobId.toString())
          tokens.push(lock.token)
          payer.push(lock.payer)
        }
      }
      if (jobIds.length > 0) {
        try {
          const tx = await this.escrow.cancelExpiredLocks(
            parseInt(chain),
            jobIds,
            tokens,
            payer,
            false
          )
          CORE_LOGGER.warn(` Canceled locks on chain ${chain}, tx:${tx}`)
        } catch (e) {
          // not critical, since we will try to cancel them at next run
          CORE_LOGGER.warn(`Tried to cancel some locks, errored: ${e.message}`)
        }
      }
    } catch (e) {
      CORE_LOGGER.error(`Error during cleanup of unknown locks: ${e.message}`)
    }
  }

  private async cleanupOldImages(): Promise<void> {
    if (!this.docker) return

    try {
      const oldImages = await this.db.getOldImages(this.retentionDays)
      if (oldImages.length === 0) {
        CORE_LOGGER.debug('No old images to clean up')
        return
      }

      CORE_LOGGER.info(`Starting cleanup of ${oldImages.length} old Docker images`)
      let cleaned = 0
      let failed = 0

      for (const image of oldImages) {
        try {
          const dockerImage = this.docker.getImage(image)
          await dockerImage.remove({ force: true })
          await this.db.deleteImage(image)
          cleaned++
          CORE_LOGGER.info(`Successfully removed old image: ${image}`)
        } catch (e) {
          failed++
          // Image might be in use or already deleted - log but don't throw
          CORE_LOGGER.debug(`Could not remove image ${image}: ${e.message}`)
        }
      }

      CORE_LOGGER.info(
        `Image cleanup completed: ${cleaned} removed, ${failed} failed (may be in use)`
      )
    } catch (e) {
      CORE_LOGGER.error(`Error during image cleanup: ${e.message}`)
    }
  }

  // eslint-disable-next-line require-await
  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments, filtered by a specific chainId if needed. Env's id already contains the cluster hash
     */
    if (!this.docker) return []
    const filteredEnvs = []
    // const systemInfo = this.docker ? await this.docker.info() : null
    for (const env of this.envs) {
      if (!chainId || (env.fees && Object.hasOwn(env.fees, String(chainId)))) {
        const computeEnv = JSON.parse(JSON.stringify(env))

        // TO DO - At some point in time we need to handle multiple runtimes
        // console.log('********************************')
        // console.log(systemInfo.GenericResources)
        // console.log('********************************')
        // if (systemInfo.Runtimes) computeEnv.runtimes = systemInfo.Runtimes
        // if (systemInfo.DefaultRuntime)
        // computeEnv.defaultRuntime = systemInfo.DefaultRuntime
        const {
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
        } = await this.getUsedResources(computeEnv)
        computeEnv.runningJobs = totalJobs
        computeEnv.runningfreeJobs = totalFreeJobs
        computeEnv.queuedJobs = queuedJobs
        computeEnv.queuedFreeJobs = queuedFreeJobs
        computeEnv.queMaxWaitTime = maxWaitTime
        computeEnv.queMaxWaitTimeFree = maxWaitTimeFree
        computeEnv.runMaxWaitTime = maxRunningTime
        computeEnv.runMaxWaitTimeFree = maxRunningTimeFree
        if (computeEnv.resources) {
          for (let i = 0; i < computeEnv.resources.length; i++) {
            if (computeEnv.resources[i].id in usedResources)
              computeEnv.resources[i].inUse = usedResources[computeEnv.resources[i].id]
            else computeEnv.resources[i].inUse = 0
          }
        }
        if (computeEnv.free && computeEnv.free.resources) {
          for (let i = 0; i < computeEnv.free.resources.length; i++) {
            if (computeEnv.free.resources[i].id in usedFreeResources)
              computeEnv.free.resources[i].inUse =
                usedFreeResources[computeEnv.free.resources[i].id]
            else computeEnv.free.resources[i].inUse = 0
          }
        }
        filteredEnvs.push(computeEnv)
      }
    }

    return filteredEnvs
  }

  private parseImage(image: string) {
    let registry = C2DEngineDocker.DEFAULT_DOCKER_REGISTRY
    let name = image
    let ref = 'latest'

    const atIdx = name.indexOf('@')
    const colonIdx = name.lastIndexOf(':')

    if (atIdx !== -1) {
      ref = name.slice(atIdx + 1)
      name = name.slice(0, atIdx)
    } else if (colonIdx !== -1 && !name.slice(colonIdx).includes('/')) {
      ref = name.slice(colonIdx + 1)
      name = name.slice(0, colonIdx)
    }

    const firstSlash = name.indexOf('/')
    if (firstSlash !== -1) {
      const potential = name.slice(0, firstSlash)
      if (potential.includes('.') || potential.includes(':')) {
        registry = potential.includes('localhost')
          ? `http://${potential}`
          : `https://${potential}`
        name = name.slice(firstSlash + 1)
      }
    }

    if (registry === C2DEngineDocker.DEFAULT_DOCKER_REGISTRY && !name.includes('/')) {
      name = `library/${name}`
    }

    return { registry, name, ref }
  }

  public async getDockerManifest(
    image: string,
    encryptedDockerRegistryAuth?: string
  ): Promise<any> {
    const { registry, name, ref } = this.parseImage(image)
    const url = `${registry}/v2/${name}/manifests/${ref}`

    // Use user provided registry auth or get it from the config
    let dockerRegistryAuth: dockerRegistryAuth | null = null
    if (encryptedDockerRegistryAuth) {
      const decryptedDockerRegistryAuth = await this.keyManager.decrypt(
        Uint8Array.from(Buffer.from(encryptedDockerRegistryAuth, 'hex')),
        EncryptMethod.ECIES
      )
      dockerRegistryAuth = JSON.parse(decryptedDockerRegistryAuth.toString())
    } else {
      dockerRegistryAuth = this.getDockerRegistryAuth(registry)
    }

    let headers: Record<string, string> = {
      Accept:
        'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json'
    }

    // If we have auth credentials, add Basic auth header to initial request
    if (dockerRegistryAuth) {
      // Use auth string if available, otherwise encode username:password
      const authString = dockerRegistryAuth.auth
        ? dockerRegistryAuth.auth
        : Buffer.from(
            `${dockerRegistryAuth.username}:${dockerRegistryAuth.password}`
          ).toString('base64')
      headers.Authorization = `Basic ${authString}`
      CORE_LOGGER.debug(
        `Using docker registry auth for ${registry} to get manifest for image ${image}`
      )
    }

    let response = await fetch(url, { headers })

    if (response.status === 401) {
      const match = (response.headers.get('www-authenticate') || '').match(
        /Bearer realm="([^"]+)",service="([^"]+)"/
      )
      if (match) {
        const tokenUrl = new URL(match[1])
        tokenUrl.searchParams.set('service', match[2])
        tokenUrl.searchParams.set('scope', `repository:${name}:pull`)

        // Add Basic auth to token request if we have credentials
        const tokenHeaders: Record<string, string> = {}
        if (dockerRegistryAuth) {
          // Use auth string if available, otherwise encode username:password
          const authString = dockerRegistryAuth.auth
            ? dockerRegistryAuth.auth
            : Buffer.from(
                `${dockerRegistryAuth.username}:${dockerRegistryAuth.password}`
              ).toString('base64')
          tokenHeaders.Authorization = `Basic ${authString}`
        }

        const { token } = (await fetch(tokenUrl.toString(), {
          headers: tokenHeaders
        }).then((r) => r.json())) as {
          token: string
        }
        headers = { ...headers, Authorization: `Bearer ${token}` }
        response = await fetch(url, { headers })
      }
    }

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Failed to get manifest: ${response.status} ${response.statusText} - ${body}`
      )
    }
    return await response.json()
  }

  /**
   * Checks the docker image by looking at local images first, then remote manifest
   * @param image name or tag
   * @param encryptedDockerRegistryAuth optional encrypted auth for remote registry
   * @param platform optional platform to validate against
   * @returns ValidateParams with valid flag and platform validation result
   */
  public async checkDockerImage(
    image: string,
    encryptedDockerRegistryAuth?: string,
    platform?: RunningPlatform
  ): Promise<ValidateParams> {
    // Step 1: Try to check local image first
    if (this.docker) {
      try {
        const dockerImage = this.docker.getImage(image)
        const imageInfo = await dockerImage.inspect()

        // Extract platform information from local image
        const localPlatform = {
          architecture: imageInfo.Architecture || 'amd64',
          os: imageInfo.Os || 'linux'
        }

        // Normalize architecture (amd64 -> x86_64 for compatibility)
        if (localPlatform.architecture === 'amd64') {
          localPlatform.architecture = 'x86_64'
        }

        // Validate platform if required
        const isValidPlatform = platform
          ? checkManifestPlatform(localPlatform, platform)
          : true

        if (isValidPlatform) {
          CORE_LOGGER.debug(`Image ${image} found locally and platform is valid`)
          return { valid: true }
        } else {
          CORE_LOGGER.warn(
            `Image ${image} found locally but platform mismatch: ` +
              `local=${localPlatform.architecture}/${localPlatform.os}, ` +
              `required=${platform.architecture}/${platform.os}`
          )
          return {
            valid: false,
            status: 400,
            reason:
              `Platform mismatch: image is ${localPlatform.architecture}/${localPlatform.os}, ` +
              `but environment requires ${platform.architecture}/${platform.os}`
          }
        }
      } catch (localErr: any) {
        // Image not found locally or error inspecting - fall through to remote check
        CORE_LOGGER.debug(
          `Image ${image} not found locally (${localErr.message}), checking remote registry`
        )
      }
    }

    // Step 2: Fall back to remote registry check (existing behavior)
    try {
      const manifest = await this.getDockerManifest(image, encryptedDockerRegistryAuth)

      const platforms = Array.isArray(manifest.manifests)
        ? manifest.manifests.map((entry: any) => entry.platform)
        : [manifest.platform]

      const isValidPlatform = platforms.some((entry: any) =>
        checkManifestPlatform(entry, platform)
      )

      return { valid: isValidPlatform }
    } catch (err: any) {
      CORE_LOGGER.error(`Unable to get Manifest for image ${image}: ${err.message}`)
      if (err.errors?.length) CORE_LOGGER.error(JSON.stringify(err.errors))

      return {
        valid: false,
        status: 404,
        reason: err.errors?.length ? JSON.stringify(err.errors) : err.message
      }
    }
  }

  // eslint-disable-next-line require-await
  public override async startComputeJob(
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
  ): Promise<ComputeJob[]> {
    if (!this.docker) return []
    // TO DO - iterate over resources and get default runtime
    const isFree: boolean = !(payment && payment.lockTx)

    if (metadata && Object.keys(metadata).length > 0) {
      const metadataSize = JSON.stringify(metadata).length
      if (metadataSize > 1024) {
        throw new Error('Metadata size is too large')
      }
    }

    const envIdWithHash = environment && environment.indexOf('-') > -1
    const env = await this.getComputeEnvironment(
      payment && payment.chainId ? payment.chainId : null,
      envIdWithHash ? environment : null,
      environment
    )
    if (!env) {
      throw new Error(`Invalid environment ${environment}`)
    }
    // C2D - Check image, check arhitecture, etc
    const image = getAlgorithmImage(algorithm, jobId)
    // ex: node@sha256:1155995dda741e93afe4b1c6ced2d01734a6ec69865cc0997daf1f4db7259a36
    if (!image) {
      // send a 500 with the error message
      throw new Error(
        `Unable to extract docker image ${image} from algoritm: ${JSON.stringify(
          algorithm
        )}`
      )
    }
    let additionalDockerFiles: { [key: string]: any } = null
    if (
      algorithm.meta &&
      algorithm.meta.container &&
      algorithm.meta.container.additionalDockerFiles
    ) {
      additionalDockerFiles = JSON.parse(
        JSON.stringify(algorithm.meta.container.additionalDockerFiles)
      )
      // make sure that we don't keep them in the db structure
      algorithm.meta.container.additionalDockerFiles = null
      if (queueMaxWaitTime && queueMaxWaitTime > 0) {
        throw new Error(`additionalDockerFiles cannot be used with queued jobs`)
      }
    }
    if (
      isFree &&
      algorithm.meta.container &&
      algorithm.meta.container.dockerfile &&
      !env.free?.allowImageBuild
    ) {
      throw new Error(`Building image is not allowed for free jobs`)
    }

    const job: DBComputeJob = {
      clusterHash: this.getC2DConfig().hash,
      containerImage: image,
      owner,
      jobId,
      jobIdHash: create256Hash(jobId),
      dateCreated: String(Date.now() / 1000),
      dateFinished: null,
      status:
        queueMaxWaitTime && queueMaxWaitTime > 0
          ? C2DStatusNumber.JobQueued
          : C2DStatusNumber.JobStarted,
      statusText:
        queueMaxWaitTime && queueMaxWaitTime > 0
          ? C2DStatusText.JobQueued
          : C2DStatusText.JobStarted,
      results: [],
      algorithm,
      assets,
      maxJobDuration,
      environment,
      configlogURL: null,
      publishlogURL: null,
      algologURL: null,
      outputsURL: null,
      stopRequested: false,
      isRunning: true,
      isStarted: false,
      resources,
      isFree,
      algoStartTimestamp: '0',
      algoStopTimestamp: '0',
      payment,
      metadata,
      additionalViewers,
      terminationDetails: { exitCode: null, OOMKilled: null },
      algoDuration: 0,
      queueMaxWaitTime: queueMaxWaitTime || 0,
      encryptedDockerRegistryAuth, // we store the encrypted docker registry auth in the job
      output,
      outputBucketId,
      buildStartTimestamp: '0',
      buildStopTimestamp: '0'
    }

    if (algorithm.meta.container && algorithm.meta.container.dockerfile) {
      // we need to build the image if job is not queued
      if (queueMaxWaitTime === 0) {
        job.status = C2DStatusNumber.BuildImage
        job.statusText = C2DStatusText.BuildImage
      }
    } else {
      // already built, we need to validate it
      const validation = await this.checkDockerImage(
        image,
        job.encryptedDockerRegistryAuth,
        env.platform
      )
      if (!validation.valid)
        throw new Error(
          `Cannot find image ${image} for ${env.platform.architecture}. Maybe it does not exist or it's build for other arhitectures.`
        )
      if (queueMaxWaitTime === 0) {
        job.status = C2DStatusNumber.PullImage
        job.statusText = C2DStatusText.PullImage
      }
    }

    if (!this.makeJobFolders(job)) {
      throw new Error('Storage failure')
    }
    // make sure we actually were able to insert on DB
    const addedId = await this.db.newJob(job)
    if (!addedId) {
      return []
    }
    if (queueMaxWaitTime === 0) {
      if (algorithm.meta.container && algorithm.meta.container.dockerfile) {
        this.buildImage(job, additionalDockerFiles)
      } else {
        this.pullImage(job)
      }
    }
    // only now set the timer
    if (!this.cronTimer) {
      this.setNewTimer()
    }
    const cjob: ComputeJob = omitDBComputeFieldsFromComputeJob(job)
    // we add cluster hash to user output
    cjob.jobId = this.getC2DConfig().hash + '-' + cjob.jobId
    // cjob.jobId = jobId
    return [cjob]
  }

  // eslint-disable-next-line require-await
  public override async stopComputeJob(
    jobId: string,
    owner: string,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    const jobs = await this.db.getJob(jobId, agreementId, owner)
    if (jobs.length === 0) {
      return []
    }
    const statusResults = []
    for (const job of jobs) {
      job.stopRequested = true
      await this.db.updateJob(job)
      const res: ComputeJob = omitDBComputeFieldsFromComputeJob(job)
      statusResults.push(res)
    }

    return statusResults
  }

  // eslint-disable-next-line require-await
  protected async getResults(jobId: string): Promise<ComputeResult[]> {
    const res: ComputeResult[] = []
    let index = 0
    try {
      const logStat = statSync(
        this.getStoragePath() + '/' + jobId + '/data/logs/image.log'
      )
      if (logStat) {
        res.push({
          filename: 'image.log',
          filesize: logStat.size,
          type: 'imageLog',
          index
        })
        index = index + 1
      }
    } catch (e) {}
    try {
      const logStat = statSync(
        this.getStoragePath() + '/' + jobId + '/data/logs/configuration.log'
      )
      if (logStat) {
        res.push({
          filename: 'configuration.log',
          filesize: logStat.size,
          type: 'configurationLog',
          index
        })
        index = index + 1
      }
    } catch (e) {}
    try {
      const logStat = statSync(
        this.getStoragePath() + '/' + jobId + '/data/logs/algorithm.log'
      )
      if (logStat) {
        res.push({
          filename: 'algorithm.log',
          filesize: logStat.size,
          type: 'algorithmLog',
          index
        })
        index = index + 1
      }
    } catch (e) {}
    try {
      // check if we have an output request.
      const jobDb = await this.db.getJob(jobId)
      if (jobDb.length < 1 || (!jobDb[0].output && !jobDb[0].outputBucketId)) {
        const outputStat = statSync(
          this.getStoragePath() + '/' + jobId + '/data/outputs/outputs.tar'
        )
        if (outputStat) {
          res.push({
            filename: 'outputs.tar',
            filesize: outputStat.size,
            type: 'output',
            index
          })
          index = index + 1
        }
      }
    } catch (e) {}
    try {
      const logStat = statSync(
        this.getStoragePath() + '/' + jobId + '/data/logs/publish.log'
      )
      if (logStat) {
        res.push({
          filename: 'publish.log',
          filesize: logStat.size,
          type: 'publishLog',
          index
        })
        index = index + 1
      }
    } catch (e) {}
    return res
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    const jobs = await this.db.getJob(jobId, agreementId, consumerAddress)
    if (jobs.length === 0) {
      return []
    }
    const statusResults = []
    for (const job of jobs) {
      const res: ComputeJob = omitDBComputeFieldsFromComputeJob(job)
      // add results for algoLogs
      res.results = await this.getResults(job.jobId)
      statusResults.push(res)
    }

    return statusResults
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number,
    offset: number = 0
  ): Promise<{ stream: Readable; headers: any }> {
    const jobs = await this.db.getJob(jobId, null, null)
    if (jobs.length === 0 || jobs.length > 1) {
      throw new Error(`Cannot find job with id ${jobId}`)
    }
    if (
      jobs[0].owner !== consumerAddress &&
      (!jobs[0].additionalViewers || !jobs[0].additionalViewers.includes(consumerAddress))
    ) {
      // consumerAddress is not the owner and not in additionalViewers
      throw new Error(
        `${consumerAddress} is not authorized to get results for job with id ${jobId}`
      )
    }
    const results = await this.getResults(jobId)
    for (const i of results) {
      if (i.index === index) {
        if (i.type === 'algorithmLog') {
          return {
            stream: createReadStream(
              this.getStoragePath() + '/' + jobId + '/data/logs/algorithm.log'
            ),
            headers: {
              'Content-Type': 'text/plain'
            }
          }
        }
        if (i.type === 'configurationLog') {
          return {
            stream: createReadStream(
              this.getStoragePath() + '/' + jobId + '/data/logs/configuration.log'
            ),
            headers: {
              'Content-Type': 'text/plain'
            }
          }
        }
        if (i.type === 'publishLog') {
          return {
            stream: createReadStream(
              this.getStoragePath() + '/' + jobId + '/data/logs/publish.log'
            ),
            headers: {
              'Content-Type': 'text/plain'
            }
          }
        }
        if (i.type === 'imageLog') {
          return {
            stream: createReadStream(
              this.getStoragePath() + '/' + jobId + '/data/logs/image.log'
            ),
            headers: {
              'Content-Type': 'text/plain'
            }
          }
        }
        if (i.type === 'output') {
          return {
            stream: createReadStream(
              this.getStoragePath() + '/' + jobId + '/data/outputs/outputs.tar',
              offset > 0 ? { start: offset } : undefined
            ),
            headers: {
              'Content-Type': 'application/octet-stream'
            }
          }
        }
      }
    }
    return null
  }

  // eslint-disable-next-line require-await
  public override async getStreamableLogs(jobId: string): Promise<NodeJS.ReadableStream> {
    const jobRes: DBComputeJob[] = await this.db.getJob(jobId)
    if (jobRes.length === 0) return null
    if (!jobRes[0].isRunning) return null
    try {
      const job = jobRes[0]
      const container = this.docker.getContainer(job.jobId + '-algoritm')
      const details = await container.inspect()
      if (details.State.Running === false) return null
      return await container.logs({
        stdout: true,
        stderr: true,
        follow: true
      })
    } catch (e) {
      CORE_LOGGER.error(`getStreamableLogs failed for job ${jobId}: ${e?.message ?? e}`)
      return null
    }
  }

  private setNewTimer() {
    if (this.cronTimer) {
      return
    }
    // don't set the cron if we don't have compute environments
    if (this.envs.length > 0)
      this.cronTimer = setTimeout(this.InternalLoop.bind(this), this.cronTime)
  }

  private async InternalLoop() {
    // this is the internal loop of docker engine
    // gets list of all running jobs and process them one by one

    // Prevent concurrent execution
    if (this.isInternalLoopRunning) {
      CORE_LOGGER.debug(
        `InternalLoop already running for engine ${this.getC2DConfig().hash}, skipping this execution`
      )
      return
    }

    this.isInternalLoopRunning = true

    if (this.cronTimer) {
      clearTimeout(this.cronTimer)
      this.cronTimer = null
    }
    try {
      // get all running jobs
      const jobs = await this.db.getRunningJobs(this.getC2DConfig().hash)

      if (jobs.length === 0) {
        CORE_LOGGER.debug('No C2D jobs found for engine ' + this.getC2DConfig().hash)
      } else {
        CORE_LOGGER.debug(
          `Got ${jobs.length} jobs for engine ${this.getC2DConfig().hash}`
        )
      }

      if (jobs.length > 0) {
        const promises: any = []
        for (const job of jobs) {
          promises.push(this.processJob(job))
        }
        // wait for all promises, there is no return
        await Promise.all(promises)
      }

      // Service-on-Demand expiry: stop services whose paid window has elapsed.
      const expiredServices = await this.db.getExpiredServiceJobs(
        this.getC2DConfig().hash
      )
      for (const svc of expiredServices) {
        CORE_LOGGER.info(`Service ${svc.serviceId} expired — stopping`)
        await this.stopService(svc.serviceId, svc.owner).catch((e) => {
          CORE_LOGGER.error(
            `Failed to stop expired service ${svc.serviceId}: ${e.message}`
          )
        })
        // mark the (now stopped) record as Expired so it is not picked up again
        const [stoppedJob] = await this.db.getServiceJob(svc.serviceId, svc.owner)
        if (stoppedJob) {
          stoppedJob.status = ServiceStatusNumber.Expired
          stoppedJob.statusText = ServiceStatusText[ServiceStatusNumber.Expired]
          await this.db.updateServiceJob(stoppedJob)
        }
      }
    } catch (e) {
      CORE_LOGGER.error(`Error in C2D InternalLoop: ${e.message}`)
    } finally {
      // Reset the flag before setting the timer
      this.isInternalLoopRunning = false
      // set the cron again
      this.setNewTimer()
    }
  }

  private async createDockerContainer(
    containerInfo: ContainerCreateOptions,
    retry: boolean = false
  ): Promise<Dockerode.Container> | null {
    try {
      const container = await this.docker.createContainer(containerInfo)
      return container
    } catch (e) {
      CORE_LOGGER.error(`Unable to create docker container: ${e.message}`)
      if (
        e.message
          .toLowerCase()
          .includes('--storage-opt is supported only for overlay over xfs') &&
        retry
      ) {
        delete containerInfo.HostConfig.StorageOpt
        CORE_LOGGER.info('Retrying again without HostConfig.StorageOpt options...')
        // Retry without that option because it does not work
        return this.createDockerContainer(containerInfo)
      }
      return null
    }
  }

  private async inspectContainer(container: Dockerode.Container): Promise<any> {
    try {
      const data = await container.inspect()
      return data.State
    } catch (e) {
      CORE_LOGGER.error(`Unable to inspect docker container: ${e.message}`)
      return null
    }
  }

  private async createDockerVolume(
    volume: VolumeCreateOptions,
    retry: boolean = false
  ): Promise<boolean> {
    try {
      await this.docker.createVolume(volume)
      return true
    } catch (e) {
      CORE_LOGGER.error(`Unable to create docker volume: ${e.message}`)
      if (
        e.message.toLowerCase().includes('quota size requested but no quota support') &&
        retry
      ) {
        delete volume.DriverOpts
        CORE_LOGGER.info('Retrying again without DriverOpts options...')
        try {
          return this.createDockerVolume(volume)
        } catch (e) {
          CORE_LOGGER.error(
            `Unable to create docker volume without DriverOpts: ${e.message}`
          )
          return false
        }
      }
      return false
    }
  }

  private getImagePullTimeoutMs(): number {
    const raw = ENVIRONMENT_VARIABLES.C2D_DOWNLOAD_TIMEOUT.value
    const parsed = raw ? parseInt(raw, 10) : NaN
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000
    }
    return 15 * 60 * 1000
  }

  // eslint-disable-next-line require-await
  private async processJob(job: DBComputeJob) {
    CORE_LOGGER.info(
      `Process job ${job.jobId} started: [STATUS: ${job.status}: ${job.statusText}]`
    )

    // has to :
    //  - monitor running containers and stop them if over limits
    //  - monitor disc space and clean up
    /* steps:
       - wait until image is ready
       - create volume
       - after image is ready, create the container
       - download assets & algo into temp folder
       - download DDOS
       - tar and upload assets & algo to container
       - start the container
       - check if container is exceeding validUntil
       - if yes, stop it
       - download /data/outputs and store it locally (or upload it somewhere)
       - delete the container
       - delete the volume
       */
    if (
      job.status === C2DStatusNumber.BuildImage ||
      job.status === C2DStatusNumber.PullImage
    ) {
      // In-process build/pull: abort if stop was requested, then let the
      // existing catch handler finalize. Otherwise let it run.
      const activeBuildAbort = this.activeBuildAborts.get(job.jobId)
      if (activeBuildAbort) {
        if (job.stopRequested === true) {
          activeBuildAbort.abort()
        }
        return
      }

      // No active build abort → orphan (the process running build/pull died).
      const isBuild = job.status === C2DStatusNumber.BuildImage
      const nowSec = Date.now() / 1000
      job.status = isBuild
        ? C2DStatusNumber.BuildImageFailed
        : C2DStatusNumber.PullImageFailed
      job.statusText = isBuild
        ? C2DStatusText.BuildImageFailed
        : C2DStatusText.PullImageFailed
      job.isRunning = false
      if (isBuild) {
        job.buildStopTimestamp = String(nowSec)
      }
      job.dateFinished = String(nowSec)

      await this.db.updateJob(job)
      await this.cleanupJob(job)
      return
    }

    if (job.status === C2DStatusNumber.JobQueued) {
      // check if we can start the job now
      const now = String(Date.now() / 1000)
      if (job.queueMaxWaitTime < parseFloat(now) - parseFloat(job.dateCreated)) {
        job.status = C2DStatusNumber.JobQueuedExpired
        job.statusText = C2DStatusText.JobQueuedExpired
        job.isRunning = false
        job.dateFinished = now
        await this.db.updateJob(job)
        await this.cleanupJob(job)
        return
      }
      // check if resources are available now
      try {
        const chainId = job.payment && job.payment.chainId ? job.payment.chainId : null
        const allEnvs = await this.getComputeEnvironments(chainId)
        const env = allEnvs.find((e) => e.id === job.environment)
        if (!env) throw new Error(`Environment ${job.environment} not found`)
        await this.checkIfResourcesAreAvailable(job.resources, env, job.isFree, allEnvs)
      } catch (err) {
        // resources are still not available
        return
      }
      // resources are now available, let's start the job
      const { algorithm } = job
      if (algorithm?.meta.container && algorithm?.meta.container.dockerfile) {
        job.status = C2DStatusNumber.BuildImage
        job.statusText = C2DStatusText.BuildImage
        this.buildImage(job, null)
      } else {
        job.status = C2DStatusNumber.PullImage
        job.statusText = C2DStatusText.PullImage
        this.pullImage(job)
      }
      await this.db.updateJob(job)
    }

    if (job.status === C2DStatusNumber.ConfiguringVolumes) {
      // we have the image (etiher pulled or built)
      // if built, check if build process took all allocated time
      // if yes, stop the job
      const buildDuration = this.getValidBuildDurationSeconds(job)
      if (buildDuration > 0 && buildDuration >= job.maxJobDuration) {
        job.isStarted = false
        job.status = C2DStatusNumber.PublishingResults
        job.statusText = C2DStatusText.PublishingResults
        job.algoStartTimestamp = '0'
        job.algoStopTimestamp = '0'
        job.isRunning = false
        await this.db.updateJob(job)
        return
      }
      // now that we have the image ready, check it for vulnerabilities
      if (this.getC2DConfig().connection?.scanImages) {
        const check = await this.checkImageVulnerability(job.containerImage)
        const imageLogFile =
          this.getStoragePath() + '/' + job.jobId + '/data/logs/image.log'
        const logText =
          `Image scanned for vulnerabilities\nVulnerable:${check.vulnerable}\nSummary:` +
          JSON.stringify(check.summary, null, 2)
        CORE_LOGGER.debug(logText)
        appendFileSync(imageLogFile, logText)
        if (check.vulnerable) {
          job.status = C2DStatusNumber.VulnerableImage
          job.statusText = C2DStatusText.VulnerableImage
          job.isRunning = false
          job.dateFinished = String(Date.now() / 1000)
          await this.db.updateJob(job)
          await this.cleanupJob(job)
          return
        }
      }
      // create the volume & create container
      // TO DO C2D:  Choose driver & size
      // get environment-specific resources for Docker device/hardware configuration
      const env = this.envs.find((e) => e.id === job.environment)
      const envResource = env?.resources || []
      const volume: VolumeCreateOptions = {
        Name: job.jobId + '-volume'
      }
      // volume
      /* const diskSize = this.getResourceRequest(job.resources, 'disk')
       if (diskSize && diskSize > 0) {
        volume.DriverOpts = {
          o: 'size=' + String(diskSize),
          device: 'local',
          type: 'local'
        }
      } */
      const volumeCreated = await this.createDockerVolume(volume, true)
      if (!volumeCreated) {
        job.status = C2DStatusNumber.VolumeCreationFailed
        job.statusText = C2DStatusText.VolumeCreationFailed
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        await this.db.updateJob(job)
        await this.cleanupJob(job)
        return
      }

      // create the container
      const mountVols: any = { '/data': {} }
      const hostConfig: HostConfig = {
        // limit number of Pids container can spawn, to avoid flooding
        PidsLimit: 512,
        Mounts: [
          {
            Type: 'volume',
            Source: volume.Name,
            Target: '/data',
            ReadOnly: false
          }
        ]
      }
      if (!env.enableNetwork) {
        hostConfig.NetworkMode = 'none' // no network inside the container
      }
      // disk
      // if (diskSize && diskSize > 0) {
      //  hostConfig.StorageOpt = {
      //  size: String(diskSize)
      // }
      // }
      // ram
      const ramSize = this.getResourceRequest(job.resources, 'ram')
      if (ramSize && ramSize > 0) {
        hostConfig.Memory = ramSize * 1024 * 1024 * 1024 // config is in GB, docker wants bytes
        // set swap to same memory value means no swap (otherwise it use like 2X mem)
        hostConfig.MemorySwap = hostConfig.Memory
      }
      const cpus = this.getResourceRequest(job.resources, 'cpu')
      if (cpus && cpus > 0) {
        hostConfig.CpuPeriod = 100000 // 100 miliseconds is usually the default
        hostConfig.CpuQuota = Math.floor(cpus * hostConfig.CpuPeriod)
        // Pin the container to specific physical CPU cores
        const cpusetStr = this.allocateCpus(job.jobId, cpus, job.environment)
        if (cpusetStr) {
          hostConfig.CpusetCpus = cpusetStr
        }
      }
      const containerInfo: ContainerCreateOptions = {
        name: job.jobId + '-algoritm',
        Image: job.containerImage,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        OpenStdin: false,
        StdinOnce: false,
        User: `${C2D_CONTAINER_UID}:${C2D_CONTAINER_GID}`,
        Volumes: mountVols,
        HostConfig: hostConfig
      }
      // TO DO - iterate over resources and get default runtime
      // TO DO - check resources and pass devices
      const dockerDeviceRequest = this.getDockerDeviceRequest(job.resources, envResource)
      if (dockerDeviceRequest) {
        containerInfo.HostConfig.DeviceRequests = dockerDeviceRequest
      }
      const advancedConfig = this.getDockerAdvancedConfig(job.resources, envResource)
      if (advancedConfig.Devices)
        containerInfo.HostConfig.Devices = advancedConfig.Devices
      if (advancedConfig.GroupAdd)
        containerInfo.HostConfig.GroupAdd = advancedConfig.GroupAdd
      containerInfo.HostConfig.SecurityOpt = [
        'no-new-privileges',
        ...(advancedConfig.SecurityOpt ?? [])
      ]
      if (advancedConfig.Binds) containerInfo.HostConfig.Binds = advancedConfig.Binds
      containerInfo.HostConfig.CapDrop = ['ALL']
      for (const cap of advancedConfig.CapDrop ?? []) {
        containerInfo.HostConfig.CapDrop.push(cap)
      }
      if (advancedConfig.CapAdd) containerInfo.HostConfig.CapAdd = advancedConfig.CapAdd
      if (advancedConfig.IpcMode)
        containerInfo.HostConfig.IpcMode = advancedConfig.IpcMode
      if (advancedConfig.ShmSize)
        containerInfo.HostConfig.ShmSize = advancedConfig.ShmSize
      if (job.algorithm?.meta.container.entrypoint) {
        const newEntrypoint = job.algorithm.meta.container.entrypoint.replace(
          '$ALGO',
          'data/transformations/algorithm'
        )
        containerInfo.Entrypoint = newEntrypoint.split(' ')
      }
      if (job.algorithm.envs) {
        const envVars: string[] = []
        for (const key of Object.keys(job.algorithm.envs)) {
          envVars.push(`${key}=${job.algorithm.envs[key]}`)
        }
        containerInfo.Env = envVars
      }
      // persistent Storage: bind-mount bucket files into the job container (localfs backend)
      for (const i in job.assets) {
        const asset = job.assets[i]
        // resolve the effective file object (plaintext, encrypted, or via documentId/serviceId)
        const resolved = await resolveComputeFileObject(asset)
        if (!resolved || !isPersistentStorageType(resolved.type)) {
          // non persistent-storage assets are downloaded later, during uploadData
          continue
        }
        // keep `resolved` local — do NOT persist the decrypted bucketId/fileName back
        // onto the job record. uploadData independently re-detects encrypted and
        // DDO-derived persistent-storage assets and skips them.
        const fo = resolved as unknown as { bucketId?: string; fileName?: string }
        if (!fo.bucketId || !fo.fileName) {
          CORE_LOGGER.error(
            `Job ${job.jobId} asset ${i}: nodePersistentStorage requires bucketId and fileName`
          )
          await this.failJobDataProvisioning(job)
          return
        }
        const ps = OceanNode.getInstance().getPersistentStorage()
        if (!ps) {
          CORE_LOGGER.error(
            `Job ${job.jobId} asset ${i}: persistent storage is not configured on this node`
          )
          await this.failJobDataProvisioning(job)
          return
        }
        try {
          const bindMount = await ps.getDockerMountObject(
            fo.bucketId,
            fo.fileName,
            job.owner
          )
          CORE_LOGGER.debug(
            `Mounting bucket ${fo.bucketId} to folder ${bindMount.Target}`
          )
          hostConfig.Mounts.push(bindMount)
          mountVols[bindMount.Target] = {}
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          CORE_LOGGER.error(
            `Job ${job.jobId} asset ${i}: failed to resolve persistent storage bind: ${errMsg}`
          )
          await this.failJobDataProvisioning(job)
          return
        }
      }
      if (job.outputBucketId) {
        try {
          const ps = OceanNode.getInstance().getPersistentStorage()
          if (!ps) {
            throw new Error('Persistent storage is not configured on this node')
          }
          const outputMount = await ps.getDockerOutputMountObject(
            job.outputBucketId,
            job.owner
          )
          CORE_LOGGER.debug(
            `Mounting output bucket ${job.outputBucketId} to folder ${outputMount.Target}`
          )
          hostConfig.Mounts.push(outputMount)
          mountVols[outputMount.Target] = {}
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          CORE_LOGGER.error(
            `Job ${job.jobId}: failed to mount output bucket ${job.outputBucketId}: ${errMsg}`
          )
          await this.failJobDataProvisioning(job)
          return
        }
      }

      const container = await this.createDockerContainer(containerInfo, true)
      if (container) {
        job.status = C2DStatusNumber.Provisioning
        job.statusText = C2DStatusText.Provisioning
        await this.db.updateJob(job)
      } else {
        job.status = C2DStatusNumber.ContainerCreationFailed
        job.statusText = C2DStatusText.ContainerCreationFailed
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        await this.db.updateJob(job)
        await this.cleanupJob(job)
        return
      }
      return
    }
    if (job.status === C2DStatusNumber.Provisioning) {
      // download algo & assets
      const ret = await this.uploadData(job)
      job.status = ret.status
      job.statusText = ret.statusText
      if (job.status !== C2DStatusNumber.RunningAlgorithm) {
        // failed, let's close it
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        await this.db.updateJob(job)
        await this.cleanupJob(job)
      } else {
        await this.db.updateJob(job)
      }
    }
    if (job.status === C2DStatusNumber.RunningAlgorithm) {
      let container
      let details
      try {
        container = this.docker.getContainer(job.jobId + '-algoritm')
        details = await container.inspect()
      } catch (e) {
        console.error(
          'Could not retrieve container: ' +
            e.message +
            '\nBack to configuring volumes to create the container...'
        )
        job.isStarted = false
        job.status = C2DStatusNumber.ConfiguringVolumes
        job.statusText = C2DStatusText.ConfiguringVolumes
        job.isRunning = false
        await this.db.updateJob(job)
        return
      }

      if (job.isStarted === false) {
        // make sure is not started
        if (details && details.State.Running === false) {
          try {
            await container.start()
            job.isStarted = true
            job.algoStartTimestamp = String(Date.now() / 1000)
            await this.db.updateJob(job)
            CORE_LOGGER.info(`Container started successfully for job ${job.jobId}`)

            await this.measureContainerBaseSize(job, container)
            return
          } catch (e) {
            // container failed to start
            job.algoStartTimestamp = String(Date.now() / 1000)
            job.algoStopTimestamp = String(Date.now() / 1000)
            try {
              const algoLogFile =
                this.getStoragePath() + '/' + job.jobId + '/data/logs/algorithm.log'
              writeFileSync(algoLogFile, String(e.message))
            } catch (e) {
              CORE_LOGGER.error('Failed to write algorithm log file: ' + e.message)
            }
            CORE_LOGGER.error('Could not start container: ' + e.message)
            job.status = C2DStatusNumber.AlgorithmFailed
            job.statusText = C2DStatusText.AlgorithmFailed

            job.isRunning = false
            job.dateFinished = String(Date.now() / 1000)
            await this.db.updateJob(job)
            await this.cleanupJob(job)
            return
          }
        }
      } else {
        const canContinue = await this.monitorDiskUsage(job)
        if (!canContinue) {
          // Job was terminated due to disk quota exceeded
          return
        }

        const timeNow = Date.now() / 1000
        let expiry

        const buildDuration = this.getValidBuildDurationSeconds(job)
        if (buildDuration > 0) {
          // if job has build time, reduce the remaining algorithm runtime budget
          expiry = parseFloat(job.algoStartTimestamp) + job.maxJobDuration - buildDuration
        } else expiry = parseFloat(job.algoStartTimestamp) + job.maxJobDuration
        CORE_LOGGER.debug(
          'container running since timeNow: ' + timeNow + ' , Expiry: ' + expiry
        )
        if (timeNow > expiry || job.stopRequested) {
          // we need to stop the container
          // make sure is running
          if (details.State.Running === true) {
            try {
              await container.stop()
            } catch (e) {
              // we should never reach this, unless the container is already stopped or deleted by someone else
              CORE_LOGGER.debug('Could not stop container: ' + e.message)
            }
          }
          job.isStarted = false
          job.status = C2DStatusNumber.PublishingResults
          job.statusText = C2DStatusText.PublishingResults
          job.algoStopTimestamp = String(Date.now() / 1000)
          job.isRunning = false
          await this.db.updateJob(job)
          return
        } else {
          if (details.State.Running === false) {
            job.isStarted = false
            job.status = C2DStatusNumber.PublishingResults
            job.statusText = C2DStatusText.PublishingResults
            const containerFinishedAt =
              new Date(details.State.FinishedAt).getTime() / 1000
            job.algoStopTimestamp = String(
              containerFinishedAt > parseFloat(job.algoStartTimestamp)
                ? containerFinishedAt
                : Date.now() / 1000
            )
            job.isRunning = false
            await this.db.updateJob(job)
            return
          }
        }
      }
    }
    if (job.status === C2DStatusNumber.PublishingResults) {
      // get output
      job.status = C2DStatusNumber.JobSettle
      job.statusText = C2DStatusText.JobSettle
      let container
      try {
        container = this.docker.getContainer(job.jobId + '-algoritm')
      } catch (e) {
        CORE_LOGGER.debug('Could not retrieve container: ' + e.message)
        job.isRunning = false
        job.dateFinished = String(Date.now() / 1000)
        try {
          const algoLogFile =
            this.getStoragePath() + '/' + job.jobId + '/data/logs/algorithm.log'
          writeFileSync(algoLogFile, String(e.message))
        } catch (e) {
          CORE_LOGGER.error('Failed to write algorithm log file: ' + e.message)
        }
        await this.db.updateJob(job)
        await this.cleanupJob(job)
        return
      }
      const state = await this.inspectContainer(container)
      if (state) {
        job.terminationDetails.OOMKilled = state.OOMKilled
        job.terminationDetails.exitCode = state.ExitCode
      } else {
        job.terminationDetails.OOMKilled = null
        job.terminationDetails.exitCode = null
      }
      const outputsArchivePath =
        this.getStoragePath() + '/' + job.jobId + '/data/outputs/outputs.tar'

      try {
        if (container) {
          if (job.outputBucketId) {
            CORE_LOGGER.info(
              `Job ${job.jobId}: results stored in bucket ${job.outputBucketId}`
            )
          } else if (job.output) {
            const decryptedOutput = await this.keyManager.decrypt(
              Uint8Array.from(Buffer.from(job.output, 'hex')),
              EncryptMethod.ECIES
            )
            const output = JSON.parse(decryptedOutput.toString()) as ComputeOutput
            const storage = Storage.getStorageClass(
              output.remoteStorage,
              this.getConfig()
            )

            if (
              storage.hasUpload &&
              'upload' in storage &&
              typeof storage.upload === 'function'
            ) {
              let uploadStream = (await container.getArchive({
                path: '/data/outputs'
              })) as unknown as Readable
              if (output.encryption && output.encryption?.key) {
                const enc = output.encryption
                const key = Uint8Array.from(Buffer.from(enc.key, 'hex'))
                uploadStream = this.keyManager.encryptStream(
                  uploadStream,
                  enc.encryptMethod,
                  key
                )
              }
              const fname =
                'outputs-' + this.getC2DConfig().hash + '-' + job.jobId + '.tar'
              await (
                storage as unknown as {
                  upload: (name: string, stream: Readable) => Promise<unknown>
                }
              ).upload(fname, uploadStream)
            } else {
              await pipeline(
                await container.getArchive({ path: '/data/outputs' }),
                createWriteStream(outputsArchivePath)
              )
            }
          } else {
            await pipeline(
              await container.getArchive({ path: '/data/outputs' }),
              createWriteStream(outputsArchivePath)
            )
          }
        }
      } catch (e) {
        CORE_LOGGER.error('Failed to get outputs archive: ' + e.message)
        job.status = C2DStatusNumber.ResultsUploadFailed
        job.statusText = C2DStatusText.ResultsUploadFailed
      }
      job.isRunning = false
      job.dateFinished = String(Date.now() / 1000)
      await this.db.updateJob(job)
      await this.cleanupJob(job)
    }
  }

  private async failJobDataProvisioning(job: DBComputeJob): Promise<void> {
    job.status = C2DStatusNumber.DataProvisioningFailed
    job.statusText = C2DStatusText.DataProvisioningFailed
    job.isRunning = false
    job.dateFinished = String(Date.now() / 1000)
    await this.db.updateJob(job)
    await this.cleanupJob(job)
  }

  // eslint-disable-next-line require-await
  private parseCpusetString(cpuset: string): number[] {
    const cores: number[] = []
    if (!cpuset) return cores
    for (const part of cpuset.split(',')) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number)
        for (let i = start; i <= end; i++) {
          cores.push(i)
        }
      } else {
        cores.push(Number(part))
      }
    }
    return cores
  }

  private allocateCpus(jobId: string, count: number, envId: string): string | null {
    const envCores = this.envCpuCoresMap.get(envId)
    if (!envCores || envCores.length === 0 || count <= 0) return null
    const existing = this.cpuAllocations.get(jobId)
    if (existing && existing.length > 0) {
      const cpusetStr = existing.join(',')
      CORE_LOGGER.info(
        `CPU affinity: reusing existing cores [${cpusetStr}] for job ${jobId}`
      )
      return cpusetStr
    }

    const usedCores = new Set<number>()
    for (const cores of this.cpuAllocations.values()) {
      for (const core of cores) {
        usedCores.add(core)
      }
    }

    const freeCores: number[] = []
    for (const core of envCores) {
      if (!usedCores.has(core)) {
        freeCores.push(core)
        if (freeCores.length === count) break
      }
    }

    if (freeCores.length < count) {
      CORE_LOGGER.warn(
        `CPU affinity: not enough free cores for job ${jobId} in env ${envId} (requested=${count}, available=${freeCores.length}/${envCores.length})`
      )
      return null
    }

    this.cpuAllocations.set(jobId, freeCores)
    const cpusetStr = freeCores.join(',')
    CORE_LOGGER.info(`CPU affinity: allocated cores [${cpusetStr}] to job ${jobId}`)
    return cpusetStr
  }

  private releaseCpus(jobId: string): void {
    const cores = this.cpuAllocations.get(jobId)
    if (cores) {
      CORE_LOGGER.info(
        `CPU affinity: released cores [${cores.join(',')}] from job ${jobId}`
      )
      this.cpuAllocations.delete(jobId)
    }
  }

  /**
   * On startup, inspects running Docker containers to rebuild the CPU allocation map.
   */
  private async rebuildCpuAllocations(): Promise<void> {
    if (this.envCpuCoresMap.size === 0) return
    try {
      const jobs = await this.db.getRunningJobs(this.getC2DConfig().hash)
      for (const job of jobs) {
        try {
          const container = this.docker.getContainer(job.jobId + '-algoritm')
          const info = await container.inspect()
          const cpuset = info.HostConfig?.CpusetCpus
          if (cpuset) {
            const cores = this.parseCpusetString(cpuset)
            if (cores.length > 0) {
              this.cpuAllocations.set(job.jobId, cores)
              CORE_LOGGER.info(
                `CPU affinity: recovered allocation [${cpuset}] for running job ${job.jobId}`
              )
            }
          }
        } catch (e) {
          // Container may not exist yet (e.g., job is in pull/build phase)
        }
      }
    } catch (e) {
      CORE_LOGGER.error(`CPU affinity: failed to rebuild allocations: ${e.message}`)
    }
  }

  private async cleanupJob(job: DBComputeJob) {
    // cleaning up
    // - claim payment or release lock
    //  - get algo logs
    //  - delete volume
    //  - delete container

    this.jobImageSizes.delete(job.jobId)
    this.releaseCpus(job.jobId)

    try {
      const container = this.docker.getContainer(job.jobId + '-algoritm')
      if (container) {
        if (job.status !== C2DStatusNumber.AlgorithmFailed) {
          writeFileSync(
            this.getStoragePath() + '/' + job.jobId + '/data/logs/algorithm.log',
            await container.logs({
              stdout: true,
              stderr: true,
              follow: false
            })
          )
        }
        await container.remove()
      }
    } catch (e) {
      // console.error('Container not found! ' + e.message)
    }
    try {
      const volume = this.docker.getVolume(job.jobId + '-volume')
      if (volume) {
        try {
          await volume.remove()
        } catch (e) {
          CORE_LOGGER.error('Failed to remove volume: ' + e.message)
        }
      }
    } catch (e) {
      CORE_LOGGER.error('Container volume not found! ' + e.message)
    }
    try {
      // remove folders
      rmSync(this.getStoragePath() + '/' + job.jobId + '/data/inputs', {
        recursive: true,
        force: true
      })
    } catch (e) {
      console.error(
        `Could not delete inputs from path ${this.getStoragePath()} for job ID ${
          job.jobId
        }! ` + e.message
      )
    }
    try {
      rmSync(this.getStoragePath() + '/' + job.jobId + '/data/transformations', {
        recursive: true,
        force: true
      })
    } catch (e) {
      console.error(
        `Could not delete algorithms from path ${this.getStoragePath()} for job ID ${job.jobId}! ` +
          e.message
      )
    }
  }

  private deleteOutputFolder(job: DBComputeJob) {
    rmSync(this.getStoragePath() + '/' + job.jobId + '/data/outputs/', {
      recursive: true,
      force: true
    })
  }

  private getDiskQuota(job: DBComputeJob): number {
    if (!job.resources) return 0

    const diskResource = job.resources.find((resource) => resource.id === 'disk')
    return diskResource ? diskResource.amount : 0
  }

  // Inspect the real runtime size of the container
  private async measureContainerBaseSize(
    job: DBComputeJob,
    container: Dockerode.Container
  ): Promise<void> {
    try {
      if (this.jobImageSizes.has(job.jobId)) {
        CORE_LOGGER.debug(`Using cached base size for job ${job.jobId.slice(-8)}`)
        return
      }

      // Wait for container filesystem to stabilize
      await new Promise((resolve) => setTimeout(resolve, 3000))

      const actualBaseSize = await this.getContainerDiskUsage(container.id, '/')
      this.jobImageSizes.set(job.jobId, actualBaseSize)

      CORE_LOGGER.info(
        `Base container ${job.containerImage} runtime size: ${(
          actualBaseSize /
          1024 /
          1024 /
          1024
        ).toFixed(2)}GB`
      )
    } catch (error) {
      CORE_LOGGER.error(`Failed to measure base container size: ${error.message}`)
      this.jobImageSizes.set(job.jobId, 0)
    }
  }

  private async getContainerDiskUsage(
    containerName: string,
    path: string = '/data'
  ): Promise<number> {
    try {
      const container = this.docker.getContainer(containerName)
      const containerInfo = await container.inspect()
      if (!containerInfo.State.Running) {
        CORE_LOGGER.debug(
          `Container ${containerName} is not running, cannot check disk usage`
        )
        return 0
      }

      const exec = await container.exec({
        Cmd: ['du', '-sb', path],
        AttachStdout: true,
        AttachStderr: true
      })

      const stream = await exec.start({ Detach: false, Tty: false })

      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer)
      }

      const output = Buffer.concat(chunks).toString()

      const match = output.match(/(\d+)\s/)
      return match ? parseInt(match[1], 10) : 0
    } catch (error) {
      CORE_LOGGER.error(
        `Failed to get container disk usage for ${containerName}: ${error.message}`
      )
      return 0
    }
  }

  private async monitorDiskUsage(job: DBComputeJob): Promise<boolean> {
    const diskQuota = this.getDiskQuota(job)
    if (diskQuota <= 0) return true

    const containerName = job.jobId + '-algoritm'
    const totalUsage = await this.getContainerDiskUsage(containerName, '/')
    const baseImageSize = this.jobImageSizes.get(job.jobId) || 0
    const algorithmUsage = Math.max(0, totalUsage - baseImageSize)

    const usageGB = (algorithmUsage / 1024 / 1024 / 1024).toFixed(2)
    const quotaGB = diskQuota.toFixed(1)
    const usagePercent = (
      (algorithmUsage / 1024 / 1024 / 1024 / diskQuota) *
      100
    ).toFixed(1)

    CORE_LOGGER.info(
      `Job ${job.jobId.slice(-8)} disk: ${usageGB}GB / ${quotaGB}GB (${usagePercent}%)`
    )

    if (algorithmUsage / 1024 / 1024 / 1024 > diskQuota) {
      CORE_LOGGER.warn(
        `DISK QUOTA EXCEEDED - Stopping job ${job.jobId}: ${usageGB}GB used, ${quotaGB}GB allowed`
      )

      try {
        const container = this.docker.getContainer(containerName)
        await container.stop()
        CORE_LOGGER.info(`Container stopped for job ${job.jobId}`)
      } catch (e) {
        CORE_LOGGER.warn(`Could not stop container: ${e.message}`)
      }

      job.status = C2DStatusNumber.DiskQuotaExceeded
      job.statusText = C2DStatusText.DiskQuotaExceeded
      job.isRunning = false
      job.isStarted = false
      job.algoStopTimestamp = String(Date.now() / 1000)
      job.dateFinished = String(Date.now() / 1000)

      await this.db.updateJob(job)
      await this.cleanupJob(job)
      CORE_LOGGER.info(`Job ${job.jobId} terminated - DISK QUOTA EXCEEDED`)

      return false
    }

    return true
  }

  private async pullImage(originaljob: DBComputeJob) {
    const job = JSON.parse(JSON.stringify(originaljob)) as DBComputeJob
    const imageLogFile = this.getStoragePath() + '/' + job.jobId + '/data/logs/image.log'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.getImagePullTimeoutMs())
    this.activeBuildAborts.set(job.jobId, controller)
    try {
      // Get registry auth for the image
      const { registry } = this.parseImage(job.containerImage)
      // Use user provided registry auth or get it from the config
      let dockerRegistryAuthForPull: any
      if (originaljob.encryptedDockerRegistryAuth) {
        const decryptedDockerRegistryAuth = await this.keyManager.decrypt(
          Uint8Array.from(Buffer.from(originaljob.encryptedDockerRegistryAuth, 'hex')),
          EncryptMethod.ECIES
        )
        dockerRegistryAuthForPull = JSON.parse(decryptedDockerRegistryAuth.toString())
      } else {
        dockerRegistryAuthForPull = this.getDockerRegistryAuth(registry)
      }

      // Prepare authconfig for Dockerode if credentials are available
      const pullOptions: any = {}
      if (dockerRegistryAuthForPull) {
        // Extract hostname from registry URL (remove protocol)
        const registryUrl = new URL(registry)
        const serveraddress =
          registryUrl.hostname + (registryUrl.port ? `:${registryUrl.port}` : '')

        // Use auth string if available, otherwise encode username:password
        const authString = dockerRegistryAuthForPull.auth
          ? dockerRegistryAuthForPull.auth
          : Buffer.from(
              `${dockerRegistryAuthForPull.username}:${dockerRegistryAuthForPull.password}`
            ).toString('base64')

        pullOptions.authconfig = {
          serveraddress,
          ...(dockerRegistryAuthForPull.auth
            ? { auth: authString }
            : {
                username: dockerRegistryAuthForPull.username,
                password: dockerRegistryAuthForPull.password
              })
        }
        CORE_LOGGER.debug(
          `Using docker registry auth for ${registry} to pull image ${job.containerImage}`
        )
      }

      pullOptions.abortSignal = controller.signal
      const pullStream = await this.docker.pull(job.containerImage, pullOptions)
      await new Promise((resolve, reject) => {
        let wroteStatusBanner = false
        this.docker.modem.followProgress(
          pullStream,
          (err: any, res: any) => {
            // onFinished
            if (err) {
              appendFileSync(imageLogFile, String(err.message))
              return reject(err)
            }
            const logText = `Successfully pulled image: ${job.containerImage}`
            CORE_LOGGER.debug(logText)
            appendFileSync(imageLogFile, logText + '\n')
            // Track image usage
            this.updateImageUsage(job.containerImage).catch((e) => {
              CORE_LOGGER.debug(`Failed to track image usage: ${e.message}`)
            })
            resolve(res)
          },
          (progress: any) => {
            // onProgress
            if (!wroteStatusBanner) {
              wroteStatusBanner = true
              CORE_LOGGER.debug('############# Pull docker image status: ##############')
            }
            // only write the status banner once, its cleaner
            let logText = ''
            if (progress.id) logText += progress.id + ' : ' + progress.status
            else logText = progress.status
            CORE_LOGGER.debug("Pulling image for jobId '" + job.jobId + "': " + logText)
            appendFileSync(imageLogFile, logText + '\n')
          }
        )
      })
      job.status = C2DStatusNumber.ConfiguringVolumes
      job.statusText = C2DStatusText.ConfiguringVolumes
      this.db.updateJob(job)
    } catch (err) {
      const logText = `Unable to pull docker image: ${job.containerImage}: ${err.message}`
      CORE_LOGGER.error(logText)
      appendFileSync(imageLogFile, logText)
      job.status = C2DStatusNumber.PullImageFailed
      job.statusText = C2DStatusText.PullImageFailed
      job.isRunning = false
      job.dateFinished = String(Date.now() / 1000)
      await this.db.updateJob(job)
      await this.cleanupJob(job)
    } finally {
      clearTimeout(timer)
      this.activeBuildAborts.delete(job.jobId)
    }
  }

  private async buildImage(
    originaljob: DBComputeJob,
    additionalDockerFiles: { [key: string]: any }
  ) {
    const job = JSON.parse(JSON.stringify(originaljob)) as DBComputeJob
    const imageLogFile = this.getStoragePath() + '/' + job.jobId + '/data/logs/image.log'
    const controller = new AbortController()
    const timeoutMs = job.maxJobDuration * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    this.activeBuildAborts.set(job.jobId, controller)
    try {
      const pack = tarStream.pack()

      // Append the Dockerfile to the tar archive
      pack.entry({ name: 'Dockerfile' }, job.algorithm.meta.container.dockerfile)
      // Append any additional files to the tar archive
      if (additionalDockerFiles) {
        for (const filePath of Object.keys(additionalDockerFiles)) {
          pack.entry({ name: filePath }, additionalDockerFiles[filePath])
        }
      }
      pack.finalize()
      job.buildStartTimestamp = String(Date.now() / 1000)
      await this.db.updateJob(job)

      const cpuperiod = 100000
      const ramGb = this.getResourceRequest(job.resources, 'ram')
      const ramBytes =
        ramGb && ramGb > 0 ? ramGb * 1024 * 1024 * 1024 : 1024 * 1024 * 1024

      const cpus = this.getResourceRequest(job.resources, 'cpu')
      const cpuquota = cpus && cpus > 0 ? Math.floor(cpus * cpuperiod) : 50000

      const buildOptions: Dockerode.ImageBuildOptions = {
        t: job.containerImage,
        memory: ramBytes,
        memswap: ramBytes, // same as memory => no swap
        cpushares: 1024, // CPU Shares (default is 1024)
        cpuquota, // 100000 = 1 CPU with cpuperiod=100000
        cpuperiod,
        nocache: true, // prevent cache poison
        abortSignal: controller.signal
      }
      // Build the image using the tar stream as context (Node IncomingMessage extends stream.Readable)
      const buildStream = (await this.docker.buildImage(pack, buildOptions)) as Readable

      const onBuildData = (data: Buffer) => {
        try {
          const text = JSON.parse(data.toString('utf8'))
          if (text && text.stream && typeof text.stream === 'string') {
            CORE_LOGGER.debug(
              "Building image for jobId '" + job.jobId + "': " + text.stream.trim()
            )
            appendFileSync(imageLogFile, String(text.stream))
          }
        } catch (e) {
          // console.log('non json build data: ', data.toString('utf8'))
        }
      }
      buildStream.on('data', onBuildData)

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const detachBuildLog = () => {
          buildStream.removeListener('data', onBuildData)
        }
        const finish = (action: () => void) => {
          if (settled) return
          settled = true
          action()
        }
        const onAbort = () => {
          finish(() => {
            detachBuildLog()
            buildStream.destroy()
            const err = new Error('Image build aborted') as NodeJS.ErrnoException
            err.code = 'ABORT_ERR'
            err.name = 'AbortError'
            reject(err)
          })
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        const onSuccess = () => {
          finish(async () => {
            detachBuildLog()
            controller.signal.removeEventListener('abort', onAbort)

            // Build stream completed, but does the image actually exist?
            try {
              await this.docker.getImage(job.containerImage).inspect()
            } catch (e) {
              return reject(
                new Error(
                  `Cannot find image '${job.containerImage}' after building. Most likely it failed: ${
                    (e as Error)?.message || String(e)
                  }`
                )
              )
            }

            CORE_LOGGER.debug(`Image '${job.containerImage}' built successfully.`)
            this.updateImageUsage(job.containerImage).catch((e) => {
              CORE_LOGGER.debug(`Failed to track image usage: ${e.message}`)
            })
            resolve()
          })
        }
        // Some HTTP responses emit `close` without a reliable `end`; handle both (settled ensures once).
        buildStream.on('end', onSuccess)
        buildStream.on('close', onSuccess)
        buildStream.on('error', (err) => {
          CORE_LOGGER.debug(`Error building image '${job.containerImage}':` + err.message)
          appendFileSync(imageLogFile, String(err.message))
          finish(() => {
            detachBuildLog()
            controller.signal.removeEventListener('abort', onAbort)
            reject(err)
          })
        })
      })
      job.status = C2DStatusNumber.ConfiguringVolumes
      job.statusText = C2DStatusText.ConfiguringVolumes
      job.buildStopTimestamp = String(Date.now() / 1000)
      await this.db.updateJob(job)
    } catch (err) {
      const aborted =
        (err as NodeJS.ErrnoException)?.code === 'ABORT_ERR' ||
        (err as Error)?.name === 'AbortError'
      if (aborted) {
        // timeout-specific handling
        const msg = `Image build timed out after ${timeoutMs / 1000}s`
        CORE_LOGGER.error(`Unable to build docker image: ${job.containerImage}: ${msg}`)
        appendFileSync(imageLogFile, msg)
      } else {
        CORE_LOGGER.error(
          `Unable to build docker image: ${job.containerImage}: ${err.message}`
        )
        appendFileSync(imageLogFile, String(err.message))
      }
      job.status = C2DStatusNumber.BuildImageFailed
      job.statusText = C2DStatusText.BuildImageFailed
      job.buildStopTimestamp = String(Date.now() / 1000)
      job.isRunning = false
      job.dateFinished = String(Date.now() / 1000)
      await this.db.updateJob(job)
      await this.cleanupJob(job)
    } finally {
      clearTimeout(timer)
      this.activeBuildAborts.delete(job.jobId)
    }
  }

  // ── Service on Demand ─────────────────────────────────────────────────

  // Pulls a plain image reference with the same registry-auth + Trivy scan
  // guarantees as pullImage(). Service code MUST go through this — never docker.pull() raw.
  private async pullImageRef(
    imageRef: string,
    encryptedDockerRegistryAuth?: string,
    logFile?: string
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.getImagePullTimeoutMs())
    try {
      const { registry } = this.parseImage(imageRef)
      let dockerRegistryAuthForPull: any
      if (encryptedDockerRegistryAuth) {
        const decryptedDockerRegistryAuth = await this.keyManager.decrypt(
          Uint8Array.from(Buffer.from(encryptedDockerRegistryAuth, 'hex')),
          EncryptMethod.ECIES
        )
        dockerRegistryAuthForPull = JSON.parse(decryptedDockerRegistryAuth.toString())
      } else {
        dockerRegistryAuthForPull = this.getDockerRegistryAuth(registry)
      }

      const pullOptions: any = { abortSignal: controller.signal }
      if (dockerRegistryAuthForPull) {
        const registryUrl = new URL(registry)
        const serveraddress =
          registryUrl.hostname + (registryUrl.port ? `:${registryUrl.port}` : '')
        const authString = dockerRegistryAuthForPull.auth
          ? dockerRegistryAuthForPull.auth
          : Buffer.from(
              `${dockerRegistryAuthForPull.username}:${dockerRegistryAuthForPull.password}`
            ).toString('base64')
        pullOptions.authconfig = {
          serveraddress,
          ...(dockerRegistryAuthForPull.auth
            ? { auth: authString }
            : {
                username: dockerRegistryAuthForPull.username,
                password: dockerRegistryAuthForPull.password
              })
        }
      }

      const pullStream = await this.docker.pull(imageRef, pullOptions)
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          pullStream,
          (err: any) => {
            if (err) {
              if (logFile) appendFileSync(logFile, String(err.message))
              return reject(err)
            }
            resolve()
          },
          (progress: any) => {
            if (logFile) appendFileSync(logFile, (progress.status ?? '') + '\n')
          }
        )
      })
      this.updateImageUsage(imageRef).catch((e) => {
        CORE_LOGGER.debug(`Failed to track image usage: ${e.message}`)
      })

      // Image scanning — same Trivy check used by the compute path.
      if (this.scanImages) {
        const scanResult = await this.checkImageVulnerability(imageRef)
        if (scanResult.vulnerable) {
          await this.docker
            .getImage(imageRef)
            .remove({ force: true })
            .catch(() => {})
          throw new Error(
            `Image "${imageRef}" failed security scan: ${JSON.stringify(scanResult.summary)}`
          )
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // Builds an image from a plain Dockerfile string with the same build mechanics as
  // buildImage(). Service code MUST go through this — never docker.buildImage() raw.
  private async buildImageFromSpec(
    imageRef: string,
    dockerfile: string,
    additionalDockerFiles: Record<string, string>,
    maxDurationSeconds: number,
    memoryGB?: number,
    cpuCount?: number
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), maxDurationSeconds * 1000)
    try {
      const pack = tarStream.pack()
      pack.entry({ name: 'Dockerfile' }, dockerfile)
      for (const [name, content] of Object.entries(additionalDockerFiles))
        pack.entry({ name }, content)
      pack.finalize()

      const buildOptions: Dockerode.ImageBuildOptions = {
        t: imageRef,
        nocache: true,
        abortSignal: controller.signal
      }
      if (memoryGB) {
        buildOptions.memory = memoryGB * 1024 ** 3
        buildOptions.memswap = memoryGB * 1024 ** 3
      }
      if (cpuCount) {
        buildOptions.cpuquota = cpuCount * 100000
        buildOptions.cpuperiod = 100000
      }

      const buildStream = (await this.docker.buildImage(pack, buildOptions)) as Readable
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(buildStream, (err: any) =>
          err ? reject(err) : resolve()
        )
      })
      // Verify image exists after build
      await this.docker.getImage(imageRef).inspect()

      // Image scanning — same Trivy gate used by pullImageRef(). A built image must clear
      // it too; on failure remove the built image so it cannot be used to start a service.
      if (this.scanImages) {
        const scanResult = await this.checkImageVulnerability(imageRef)
        if (scanResult.vulnerable) {
          await this.docker
            .getImage(imageRef)
            .remove({ force: true })
            .catch(() => {})
          throw new Error(
            `Image "${imageRef}" failed security scan: ${JSON.stringify(scanResult.summary)}`
          )
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // Builds Docker HostConfig resource constraints (memory, cpu, GPU device requests)
  // from a service resource request, resolved against the connection-level resource pool.
  private buildServiceResourceConstraints(resources: ComputeResourceRequest[]): {
    Memory?: number
    NanoCpus?: number
    DeviceRequests?: any[]
  } {
    const connResources: ComputeResource[] =
      this.getC2DConfig().connection?.resources ?? []
    const ram = resources.find((r) => r.id === 'ram')?.amount
    const cpu = resources.find((r) => r.id === 'cpu')?.amount
    const deviceRequests = this.getDockerDeviceRequest(resources, connResources) ?? []
    return {
      Memory: ram ? ram * 1024 ** 3 : undefined,
      NanoCpus: cpu ? cpu * 1e9 : undefined,
      DeviceRequests: deviceRequests.length ? deviceRequests : undefined
    }
  }

  public override async startService(
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
    userData?: string
  ): Promise<ServiceJob | null> {
    // 1. Resolve final container image reference
    const containerImage = resolveServiceImage(
      image,
      tag,
      checksum,
      dockerfile,
      serviceId
    )

    // 1a. Decrypt the userData ECIES string once, in memory, for building the container env.
    //     The encrypted string itself is what gets stored — plaintext is never persisted.
    const decryptedUserData = await decryptUserData(userData, this.keyManager)

    // 1b. Write initial DB record (status: Starting). userData stored as received (encrypted).
    const job: ServiceJob = {
      serviceId,
      clusterHash: this.getC2DConfig().hash,
      environment,
      owner,
      image,
      tag,
      checksum,
      dockerfile,
      additionalDockerFiles,
      dockerCmd,
      dockerEntrypoint,
      containerImage,
      containerId: '',
      networkId: '',
      status: ServiceStatusNumber.Starting,
      statusText: ServiceStatusText[ServiceStatusNumber.Starting],
      dateCreated: new Date().toISOString(),
      expiresAt: Date.now() + duration * 1000,
      duration,
      exposedPorts,
      endpoints: [],
      userData,
      resources: resources.map((r) => ({ id: r.id, amount: r.amount })),
      payment
    }
    await this.db.newServiceJob(job)

    // Live Docker handles, tracked so the catch block can tear down a half-created
    // service (otherwise the network leaks and exhausts the daemon's IPAM pool).
    let network: Dockerode.Network | null = null
    let container: Dockerode.Container | null = null
    try {
      const sod = this.getC2DConfig().connection?.serviceOnDemand
      // 2. Pull or build image
      if (dockerfile) {
        if (!sod?.allowImageBuild)
          throw new Error(
            'Dockerfile-based services are not allowed on this environment (allowImageBuild=false)'
          )
        job.status = ServiceStatusNumber.BuildImage
        job.statusText = ServiceStatusText[ServiceStatusNumber.BuildImage]
        await this.db.updateServiceJob(job)
        const ram = resources.find((r) => r.id === 'ram')?.amount
        const cpu = resources.find((r) => r.id === 'cpu')?.amount
        await this.buildImageFromSpec(
          containerImage,
          dockerfile,
          additionalDockerFiles ?? {},
          sod?.maxDurationSeconds ?? duration,
          ram,
          cpu
        )
      } else {
        job.status = ServiceStatusNumber.PullImage
        job.statusText = ServiceStatusText[ServiceStatusNumber.PullImage]
        await this.db.updateServiceJob(job)
        await this.pullImageRef(containerImage)
      }

      // 3. Allocate one host port per exposedPort from the daemon's configured range.
      // Sequential (not Promise.all) with explicit rollback: at this point job.endpoints
      // is not populated yet, so a mid-way allocation failure would otherwise leave the
      // already-reserved ports stranded in the in-memory allocatedPorts set.
      const [rangeStart, rangeEnd] = sod?.hostPortRange ?? [30000, 32767]
      const hostPorts: number[] = []
      try {
        for (let i = 0; i < exposedPorts.length; i++) {
          // eslint-disable-next-line no-await-in-loop
          hostPorts.push(await allocateHostPort(rangeStart, rangeEnd))
        }
      } catch (e) {
        for (const port of hostPorts) releaseHostPort(port)
        throw e
      }

      // 4. Build endpoints — nodeHost is the operator-configured reachable host
      const nodeHost = sod?.nodeHost ?? 'localhost'
      const endpoints: ServiceEndpoint[] = exposedPorts.map((cp, i) => ({
        containerPort: cp,
        hostPort: hostPorts[i],
        url: `http://${nodeHost}:${hostPorts[i]}`
      }))
      job.endpoints = endpoints

      // 5. Per-service Docker network
      network = await this.docker.createNetwork({ Name: `ocean-svc-${serviceId}` })

      // 6. Container env from the decrypted (in-memory) userData; command/entrypoint from the request.
      const env = userDataToEnv(decryptedUserData)
      const cmd = dockerCmd?.length ? dockerCmd : undefined
      const entrypoint = dockerEntrypoint?.length ? dockerEntrypoint : undefined

      // 7. Port bindings
      const PortBindings: Record<string, Array<{ HostPort: string }>> = {}
      const ExposedPorts: Record<string, Record<string, never>> = {}
      exposedPorts.forEach((cp, i) => {
        PortBindings[`${cp}/tcp`] = [{ HostPort: String(hostPorts[i]) }]
        ExposedPorts[`${cp}/tcp`] = {}
      })

      // 8. Resource constraints
      const { Memory, NanoCpus, DeviceRequests } =
        this.buildServiceResourceConstraints(resources)

      // 9. Create and start container
      container = await this.docker.createContainer({
        Image: containerImage,
        Cmd: cmd,
        Entrypoint: entrypoint,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts,
        HostConfig: {
          Memory,
          NanoCpus,
          DeviceRequests,
          PortBindings,
          NetworkMode: network.id,
          SecurityOpt: ['no-new-privileges'], // security plan #5
          CapDrop: ['ALL'],
          PidsLimit: 512
        }
      })
      await container.start()

      // 10. Update to Running.
      job.containerId = container.id
      job.networkId = network.id
      job.status = ServiceStatusNumber.Running
      job.statusText = ServiceStatusText[ServiceStatusNumber.Running]
      await this.db.updateServiceJob(job)
      return job
    } catch (err: any) {
      await this.cleanupServiceDocker(container, network)
      for (const ep of job.endpoints) releaseHostPort(ep.hostPort)
      job.status = dockerfile
        ? ServiceStatusNumber.BuildImageFailed
        : ServiceStatusNumber.PullImageFailed
      // If the failure was past image preparation, mark generic Error.
      if (job.containerId === '' && job.endpoints.length > 0)
        job.status = ServiceStatusNumber.Error
      job.statusText = String(err.message)
      await this.db.updateServiceJob(job)
      CORE_LOGGER.error(`startService ${serviceId} failed: ${err.message}`)
      throw err
    }
  }

  // Best-effort teardown of a half-created service container + network. Used by the
  // startService / restartService failure paths to avoid leaking Docker networks
  // (which would exhaust the daemon's IPAM CIDR pool over repeated failures).
  private async cleanupServiceDocker(
    container: Dockerode.Container | null,
    network: Dockerode.Network | null
  ): Promise<void> {
    if (container) {
      await container.stop({ t: 5 }).catch(() => {})
      await container.remove({ force: true }).catch(() => {})
    }
    if (network) {
      await network.remove().catch(() => {})
    }
  }

  public override async stopService(
    serviceId: string,
    owner: string
  ): Promise<ServiceJob | null> {
    const [job] = await this.db.getServiceJob(serviceId, owner)
    if (!job) return null
    if (
      job.status === ServiceStatusNumber.Stopped ||
      job.status === ServiceStatusNumber.Expired
    )
      return job

    job.status = ServiceStatusNumber.Stopping
    job.statusText = ServiceStatusText[ServiceStatusNumber.Stopping]
    await this.db.updateServiceJob(job)

    // "Already gone" Docker errors (404 missing, 304 already stopped) are the desired end
    // state, so treat them as success. Any other error means teardown genuinely failed —
    // record it and keep the job OUT of Stopped so the persisted state stays accurate.
    const isBenignDockerError = (e: any) => e?.statusCode === 404 || e?.statusCode === 304
    let cleanupError: Error | null = null
    try {
      if (job.containerId) {
        const c = this.docker.getContainer(job.containerId)
        await c.stop({ t: 10 }).catch((e) => {
          if (!isBenignDockerError(e)) throw e
        })
        await c.remove({ force: true }).catch((e) => {
          if (!isBenignDockerError(e)) throw e
        })
      }
      if (job.networkId) {
        await this.docker
          .getNetwork(job.networkId)
          .remove()
          .catch((e) => {
            if (!isBenignDockerError(e)) throw e
          })
      }
      // Only release the reserved host ports once the container is confirmed gone — a
      // port still bound by a not-removed container must not be handed to another service.
      for (const ep of job.endpoints) releaseHostPort(ep.hostPort)
    } catch (err: any) {
      cleanupError = err
      CORE_LOGGER.error(`stopService ${serviceId} cleanup error: ${err.message}`)
    }

    if (cleanupError) {
      job.status = ServiceStatusNumber.Error
      job.statusText = `stop failed: ${cleanupError.message}`
    } else {
      job.status = ServiceStatusNumber.Stopped
      job.statusText = ServiceStatusText[ServiceStatusNumber.Stopped]
    }
    await this.db.updateServiceJob(job)
    return job
  }

  public override async restartService(
    serviceId: string,
    owner: string,
    newUserData?: string
  ): Promise<ServiceJob | null> {
    const [job] = await this.db.getServiceJob(serviceId, owner)
    if (!job) return null
    // Reject on the expiry timestamp too, not just the status: the expiry cron flips the
    // status asynchronously, so a service can be past its paid window before it reads Expired.
    // Restarting then would silently extend the service beyond what was paid for.
    if (job.status === ServiceStatusNumber.Expired || Date.now() >= job.expiresAt)
      throw new Error('Cannot restart an expired service')

    // 1. Tear down existing container + network (best-effort)
    if (job.containerId) {
      const c = this.docker.getContainer(job.containerId)
      await c.stop({ t: 10 }).catch(() => {})
      await c.remove({ force: true }).catch(() => {})
    }
    if (job.networkId) {
      await this.docker
        .getNetwork(job.networkId)
        .remove()
        .catch(() => {})
    }

    job.status = ServiceStatusNumber.Starting
    job.statusText = ServiceStatusText[ServiceStatusNumber.Starting]
    job.containerId = ''
    job.networkId = ''
    await this.db.updateServiceJob(job)

    // Live Docker handles for the newly-created container/network, tracked so the
    // catch block can tear them down on failure (otherwise the network leaks).
    let network: Dockerode.Network | null = null
    let container: Dockerode.Container | null = null
    try {
      const sod = this.getC2DConfig().connection?.serviceOnDemand

      // 2. Pull or rebuild image based on how the service was originally started
      //    (the original Dockerfile + build files are stored on the job).
      if (job.dockerfile) {
        job.status = ServiceStatusNumber.BuildImage
        job.statusText = ServiceStatusText[ServiceStatusNumber.BuildImage]
        await this.db.updateServiceJob(job)
        const ram = job.resources.find((r) => r.id === 'ram')?.amount
        const cpu = job.resources.find((r) => r.id === 'cpu')?.amount
        await this.buildImageFromSpec(
          job.containerImage,
          job.dockerfile,
          job.additionalDockerFiles ?? {},
          sod?.maxDurationSeconds ?? job.duration,
          ram,
          cpu
        )
      } else {
        job.status = ServiceStatusNumber.PullImage
        job.statusText = ServiceStatusText[ServiceStatusNumber.PullImage]
        await this.db.updateServiceJob(job)
        await this.pullImageRef(job.containerImage)
      }

      // 3. Effective userData: newUserData REPLACES the stored one when supplied.
      const effectiveUserData = newUserData ?? job.userData
      const decryptedUserData = await decryptUserData(effectiveUserData, this.keyManager)

      // 4. Rebuild env (from userData) + command/entrypoint (stored on the job)
      const env = userDataToEnv(decryptedUserData)
      const cmd = job.dockerCmd?.length ? job.dockerCmd : undefined
      const entrypoint = job.dockerEntrypoint?.length ? job.dockerEntrypoint : undefined

      // 5. Rebuild port bindings — reuse already-allocated host ports
      const PortBindings: Record<string, Array<{ HostPort: string }>> = {}
      const ExposedPorts: Record<string, Record<string, never>> = {}
      job.endpoints.forEach((ep) => {
        PortBindings[`${ep.containerPort}/tcp`] = [{ HostPort: String(ep.hostPort) }]
        ExposedPorts[`${ep.containerPort}/tcp`] = {}
      })

      // 6. New per-service network
      network = await this.docker.createNetwork({ Name: `ocean-svc-${serviceId}` })

      // 7. Resource constraints
      const { Memory, NanoCpus, DeviceRequests } = this.buildServiceResourceConstraints(
        job.resources.map((r) => ({ id: r.id, amount: r.amount }))
      )

      // 8. Create and start new container
      container = await this.docker.createContainer({
        Image: job.containerImage,
        Cmd: cmd,
        Entrypoint: entrypoint,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts,
        HostConfig: {
          Memory,
          NanoCpus,
          DeviceRequests,
          PortBindings,
          NetworkMode: network.id,
          SecurityOpt: ['no-new-privileges'],
          CapDrop: ['ALL'],
          PidsLimit: 512
        }
      })
      await container.start()

      // 9. Update record — same expiresAt, same payment, new container/network.
      job.containerId = container.id
      job.networkId = network.id
      job.userData = effectiveUserData
      job.status = ServiceStatusNumber.Running
      job.statusText = ServiceStatusText[ServiceStatusNumber.Running]
      await this.db.updateServiceJob(job)
      return job
    } catch (err: any) {
      await this.cleanupServiceDocker(container, network)
      job.status = ServiceStatusNumber.Error
      job.statusText = String(err.message)
      await this.db.updateServiceJob(job)
      CORE_LOGGER.error(`restartService ${serviceId} failed: ${err.message}`)
      throw err
    }
  }

  public override async getServiceStatus(
    consumerAddress?: string,
    serviceId?: string
  ): Promise<ServiceJob[]> {
    const jobs = await this.db.getServiceJob(serviceId, consumerAddress)
    return jobs.filter((j) => j.clusterHash === this.getC2DConfig().hash)
  }

  private addUserDataToFilesObject(
    filesObject: any,
    userData: { [key: string]: any }
  ): any {
    if (filesObject?.url && userData) {
      const url = new URL(filesObject.url)
      const userDataObj = typeof userData === 'string' ? JSON.parse(userData) : userData
      for (const [key, value] of Object.entries(userDataObj)) {
        url.searchParams.append(key, String(value))
      }
      filesObject.url = url.toString()
      CORE_LOGGER.info('Appended userData to file url: ' + filesObject.url)
    }
    return filesObject
  }

  private async uploadData(
    job: DBComputeJob
  ): Promise<{ status: C2DStatusNumber; statusText: C2DStatusText }> {
    const config = this.getConfig()
    const ret = {
      status: C2DStatusNumber.RunningAlgorithm,
      statusText: C2DStatusText.RunningAlgorithm
    }
    const jobFolderPath = this.getStoragePath() + '/' + job.jobId
    const fullAlgoPath = jobFolderPath + '/data/transformations/algorithm'
    const configLogPath = jobFolderPath + '/data/logs/configuration.log'

    try {
      appendFileSync(
        configLogPath,
        "Writing algocustom data to '/data/inputs/algoCustomData.json'\n"
      )
      const customdataPath =
        this.getStoragePath() + '/' + job.jobId + '/data/inputs/algoCustomData.json'
      writeFileSync(customdataPath, JSON.stringify(job.algorithm.algocustomdata ?? {}))

      let storage = null

      if (job.algorithm.meta.rawcode && job.algorithm.meta.rawcode.length > 0) {
        // we have the code, just write it
        appendFileSync(configLogPath, `Writing raw algo code to ${fullAlgoPath}\n`)
        writeFileSync(fullAlgoPath, job.algorithm.meta.rawcode)
      } else {
        // resolve the effective algorithm file object (plaintext, encrypted, or via
        // documentId/serviceId). All types — including nodePersistentStorage — are
        // streamed uniformly through the Storage class (job.owner enforces the bucket
        // ACL for persistent storage).
        const resolved = await resolveComputeFileObject(job.algorithm)
        if (!resolved) {
          CORE_LOGGER.info(
            'Could not extract any files object from the compute algorithm, skipping...'
          )
          appendFileSync(
            configLogPath,
            'Could not extract any files object from the compute algorithm, skipping...\n'
          )
        } else {
          try {
            storage = Storage.getStorageClass(resolved, config, job.owner)
          } catch (e) {
            CORE_LOGGER.error(`Unable to get storage class for algorithm: ${e.message}`)
            appendFileSync(
              configLogPath,
              `Unable to get storage class for algorithm: ${e.message}\n`
            )
            return {
              status: C2DStatusNumber.AlgorithmProvisioningFailed,
              statusText: C2DStatusText.AlgorithmProvisioningFailed
            }
          }
          await pipeline(
            (await storage.getReadableStream()).stream,
            createWriteStream(fullAlgoPath)
          )
        }
      }
    } catch (e) {
      CORE_LOGGER.error(
        'Unable to write algorithm to path: ' + fullAlgoPath + ': ' + e.message
      )
      appendFileSync(
        configLogPath,
        'Unable to write algorithm to path: ' + fullAlgoPath + ': ' + e.message + '\n'
      )
      return {
        status: C2DStatusNumber.AlgorithmProvisioningFailed,
        statusText: C2DStatusText.AlgorithmProvisioningFailed
      }
    }

    // now for the assets
    for (const i in job.assets) {
      const asset = job.assets[i]
      let storage = null
      let fileInfo = null
      appendFileSync(configLogPath, `Downloading asset ${i} to /data/inputs/\n`)
      // without this check it would break if no fileObject is present
      if (asset.fileObject) {
        try {
          if (asset.fileObject.type) {
            if (isPersistentStorageType(asset.fileObject.type)) {
              // persistent storage is handled during ConfiguringVolumes via bind mounts
              continue
            }
            storage = Storage.getStorageClass(asset.fileObject, config)
          } else {
            CORE_LOGGER.info('asset file object seems to be encrypted, checking it...')
            // get the encrypted bytes
            let filesObject: any = await decryptFilesObject(asset.fileObject)
            // persistent storage assets are bind-mounted during ConfiguringVolumes;
            // skip download here even if the resolved object wasn't written back
            if (isPersistentStorageType(filesObject?.type)) {
              continue
            }
            filesObject = await this.addUserDataToFilesObject(filesObject, asset.userdata)
            storage = Storage.getStorageClass(filesObject, config)
          }

          // we need the file info for the name (but could be something else here)
          fileInfo = await storage.getFileInfo({
            type: storage.getStorageType(asset.fileObject)
          })
        } catch (e) {
          CORE_LOGGER.error(`Unable to get storage class for asset: ${e.message}`)
          appendFileSync(
            configLogPath,
            `Unable to get storage class for asset: ${e.message}\n`
          )
          return {
            status: C2DStatusNumber.DataProvisioningFailed,
            statusText: C2DStatusText.DataProvisioningFailed
          }
        }
      } else {
        // we need to go the hard way
        const { serviceId, documentId } = asset
        appendFileSync(
          configLogPath,
          `Using ${documentId} and serviceId ${serviceId} for this asset.\n`
        )
        if (serviceId && documentId) {
          // need to get the file
          try {
            const ddo = await new FindDdoHandler(
              OceanNode.getInstance()
            ).findAndFormatDdo(documentId)
            // 2. Get the service
            const service: Service = AssetUtils.getServiceById(ddo, serviceId)
            // 3. Decrypt the url
            let decryptedFileObject = await decryptFilesObject(service.files)
            // persistent storage assets are bind-mounted during ConfiguringVolumes
            if (isPersistentStorageType(decryptedFileObject?.type)) {
              continue
            }
            decryptedFileObject = await this.addUserDataToFilesObject(
              decryptedFileObject,
              asset.userdata
            )
            storage = Storage.getStorageClass(decryptedFileObject, config)
            fileInfo = await storage.getFileInfo({
              type: storage.getStorageType(decryptedFileObject)
            })
          } catch (e) {
            CORE_LOGGER.error(`Unable to get storage class for asset: ${e.message}`)
            appendFileSync(
              configLogPath,
              `Unable to get storage class for asset: ${e.message}\n`
            )
            return {
              status: C2DStatusNumber.DataProvisioningFailed,
              statusText: C2DStatusText.DataProvisioningFailed
            }
          }
        }
      }

      if (storage && fileInfo) {
        const fullPath = jobFolderPath + '/data/inputs/' + fileInfo[0].name
        appendFileSync(configLogPath, `Downloading asset to ${fullPath}\n`)
        try {
          await pipeline(
            (await storage.getReadableStream()).stream,
            createWriteStream(fullPath)
          )
        } catch (e) {
          CORE_LOGGER.error(
            'Unable to write input data to path: ' + fullPath + ': ' + e.message
          )
          appendFileSync(
            configLogPath,
            'Unable to write input data to path: ' + fullPath + ': ' + e.message + '\n'
          )
          return {
            status: C2DStatusNumber.DataProvisioningFailed,
            statusText: C2DStatusText.DataProvisioningFailed
          }
        }
      } else {
        CORE_LOGGER.info(
          'Could not extract any files object from the compute asset, skipping...'
        )
        appendFileSync(
          configLogPath,
          'Could not extract any files object from the compute asset, skipping...\n'
        )
      }
    }
    CORE_LOGGER.info('All good with data provisioning, will start uploading it...')
    appendFileSync(
      configLogPath,
      'All good with data provisioning, will start uploading it...\n'
    )
    // now, we have to create a tar arhive
    const folderToTar = jobFolderPath + '/data'
    const destination = jobFolderPath + '/tarData/upload.tar.gz'
    try {
      tar.create(
        {
          gzip: true,
          file: destination,
          sync: true,
          C: folderToTar
        },
        ['./']
      )
      // check if tar.gz actually exists

      if (existsSync(destination)) {
        // now, upload it to the container
        const container = this.docker.getContainer(job.jobId + '-algoritm')

        try {
          // await container2.putArchive(destination, {
          await container.putArchive(destination, {
            path: '/data'
          })
        } catch (e) {
          appendFileSync(
            configLogPath,
            'Data upload to container failed: ' + e.message + '\n'
          )
          return {
            status: C2DStatusNumber.DataUploadFailed,
            statusText: C2DStatusText.DataUploadFailed
          }
        }
      } else {
        CORE_LOGGER.debug('No data to upload, empty tar.gz')
        appendFileSync(configLogPath, `No data to upload, empty tar.gz\n`)
      }
    } catch (e) {
      CORE_LOGGER.debug(e.message)
      appendFileSync(configLogPath, `Error creating data archive: ${e.message}\n`)
      return {
        status: C2DStatusNumber.DataProvisioningFailed,
        statusText: C2DStatusText.DataProvisioningFailed
      }
    }

    rmSync(jobFolderPath + '/data/inputs', {
      recursive: true,
      force: true
    })
    rmSync(jobFolderPath + '/data/transformations', {
      recursive: true,
      force: true
    })
    rmSync(jobFolderPath + '/tarData', {
      recursive: true,
      force: true
    })
    return ret
  }

  private makeJobFolders(job: DBComputeJob): boolean {
    try {
      const baseFolder = this.getStoragePath() + '/' + job.jobId
      const dirs = [
        baseFolder,
        baseFolder + '/data',
        baseFolder + '/data/inputs',
        baseFolder + '/data/transformations',
        baseFolder + '/data/ddos',
        baseFolder + '/data/outputs',
        baseFolder + '/data/logs',
        baseFolder + '/tarData'
      ]
      for (const dir of dirs) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        // update directory permissions to allow read/write from job containers
        chmodSync(dir, 0o777)
      }
      return true
    } catch (e) {
      CORE_LOGGER.error('Failed to create folders needed for the job: ' + e.message)
      return false
    }
  }

  // clean up temporary files
  public override async cleanupExpiredStorage(
    job: DBComputeJob,
    isCleanAfterDownload: boolean = false
  ): Promise<boolean> {
    if (!job) return false
    CORE_LOGGER.info('Cleaning up C2D storage for Job: ' + job.jobId)
    try {
      // delete the storage
      // for free env, the container is deleted as soon as we download the results
      // so we avoid trying to do it again
      if (!isCleanAfterDownload) {
        await this.cleanupJob(job)
      }

      // delete output folders
      this.deleteOutputFolder(job)
      // delete the job
      await this.db.deleteJob(job.jobId)
      return true
    } catch (e) {
      CORE_LOGGER.error('Error cleaning up C2D storage and Job: ' + e.message)
    }
    return false
  }

  private getValidBuildDurationSeconds(job: DBComputeJob): number {
    const startRaw = job.buildStartTimestamp
    const stopRaw = job.buildStopTimestamp
    if (!startRaw || !stopRaw) return 0
    const start = Number.parseFloat(startRaw)
    const stop = Number.parseFloat(stopRaw)
    if (!Number.isFinite(start) || !Number.isFinite(stop)) return 0
    if (start <= 0) return 0
    if (stop < start) return 0
    return stop - start
  }

  private async checkscanDBImage(): Promise<boolean> {
    // 1. Pull the image if it's missing locally
    try {
      await this.docker.getImage(trivyImage).inspect()
      return true
    } catch (error) {
      if (error.statusCode === 404) {
        CORE_LOGGER.info(`Trivy not found. Pulling ${trivyImage}...`)
        const stream = await this.docker.pull(trivyImage)

        // We must wrap the pull stream in a promise to wait for completion
        await new Promise((resolve, reject) => {
          this.docker.modem.followProgress(stream, (err, res) =>
            err ? reject(err) : resolve(res)
          )
        })

        CORE_LOGGER.info('Pull complete.')
        return true
      } else {
        CORE_LOGGER.error(`Unable to pull ${trivyImage}: ${error.message}`)
        return true
      }
    }
  }

  private async scanDBUpdate(): Promise<void> {
    CORE_LOGGER.info('Starting Trivy database refresh cron')
    const hasImage = await this.checkscanDBImage()
    if (!hasImage) {
      // we cannot update without image
      return
    }
    const updater = await this.docker.createContainer({
      Image: trivyImage,
      Cmd: ['image', '--download-db-only'], // Only refreshes the cache
      HostConfig: {
        Binds: [`${this.trivyCachePath}:/root/.cache/trivy`]
      }
    })

    await updater.start()
    await updater.wait()
    await updater.remove()
    CORE_LOGGER.info('Trivy database refreshed.')
  }

  private async scanImage(imageName: string) {
    if (!imageName || !imageName.trim()) return null
    const hasImage = await this.checkscanDBImage()
    if (!hasImage) {
      // we cannot update without image
      return
    }
    CORE_LOGGER.debug(`Starting vulnerability check for ${imageName}`)
    const container = await this.docker.createContainer({
      Image: trivyImage,
      Cmd: [
        'image',
        '--format',
        'json',
        '--quiet',
        '--no-progress',
        '--skip-db-update',
        '--severity',
        'CRITICAL,HIGH',
        imageName
      ],
      HostConfig: {
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock', // To see local images
          `${this.trivyCachePath}:/root/.cache/trivy` // THE CACHE BIND
        ]
      }
    })

    await container.start()

    // Wait for completion, then parse from *demuxed stdout* to avoid corrupt JSON
    // due to Docker multiplexed log framing.
    const logsStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true
    })

    const outStream = new PassThrough()
    const errStream = new PassThrough()
    outStream.resume()
    errStream.resume()

    const rawChunks: Buffer[] = []
    outStream.on('data', (chunk) => {
      rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    container.modem.demuxStream(logsStream, outStream, errStream)

    const logsDrained = new Promise<void>((resolve, reject) => {
      const done = () => resolve()
      logsStream.once('end', done)
      logsStream.once('close', done)
      logsStream.once('error', reject)
    })

    await container.wait()
    // Wait for the docker log stream to finish producing data.
    await logsDrained

    await container.remove()
    CORE_LOGGER.debug(`Vulnerability check for ${imageName} finished`)

    try {
      const rawData = Buffer.concat(rawChunks).toString('utf8')
      // Trivy's `--format json` output is a JSON object (it includes `SchemaVersion`).
      // Prefer extracting the JSON object only; do not attempt array parsing since
      // Trivy help/usage output may include `[` tokens (e.g. "[flags]") that are not JSON.
      const firstBrace = rawData.indexOf('{')
      const lastBrace = rawData.lastIndexOf('}')

      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonText = rawData.slice(firstBrace, lastBrace + 1).trim()
        if (!jsonText.includes('"SchemaVersion"')) {
          CORE_LOGGER.error(
            'Trivy output did not contain SchemaVersion in extracted JSON. Truncated output: ' +
              rawData.slice(0, 500)
          )
          return null
        }
        return JSON.parse(jsonText)
      }

      CORE_LOGGER.error(
        `Failed to locate JSON in Trivy output. Truncated output: ${rawData.slice(
          0,
          1000
        )}`
      )
      return null
    } catch (e) {
      CORE_LOGGER.error('Failed to parse Trivy output: ' + e.message)
      return null
    }
  }

  private async checkImageVulnerability(imageName: string) {
    const report = await this.scanImage(imageName)
    if (!report) {
      //
      return { vulnerable: false, summary: 'failed to scan' }
    }
    // Results is an array (one entry per OS package manager / language)
    const allVulnerabilities = report.Results.flatMap((r: any) => r.Vulnerabilities || [])

    const severityRank = (sev: string) => {
      switch (sev) {
        case 'CRITICAL':
          return 3
        case 'HIGH':
          return 2
        default:
          return 1
      }
    }

    const summary = {
      total: allVulnerabilities.length,
      critical: allVulnerabilities.filter((v: any) => v.Severity === 'CRITICAL').length,
      high: allVulnerabilities.filter((v: any) => v.Severity === 'HIGH').length,
      list: (() => {
        // Present the most important vulnerabilities first.
        const sorted = [...allVulnerabilities].sort((a: any, b: any) => {
          const diff = severityRank(b.Severity) - severityRank(a.Severity)
          if (diff !== 0) return diff
          return String(a.VulnerabilityID || '').localeCompare(
            String(b.VulnerabilityID || '')
          )
        })

        const list: Array<{
          severity: string
          id: string
          package: string
          title: string
        }> = []

        for (const v of sorted) {
          list.push({
            severity: v.Severity,
            id: v.VulnerabilityID,
            package: v.PkgName,
            title: v.Title || 'No description'
          })
        }

        return list
      })()
    }

    if (summary.critical > 0) {
      return {
        vulnerable: true,
        summary
      }
    }

    return { vulnerable: false, summary }
  }
}

// this uses the docker engine, but exposes only one env, the free one

/**
 * Resolves the effective (decrypted) file object for a compute asset or algorithm.
 * Handles the three ways a file object can arrive:
 *  1. plaintext file object (already has a `type`)
 *  2. encrypted file object (no `type`) -> decrypt it
 *  3. no file object, only `documentId` + `serviceId` -> resolve the DDO and decrypt `service.files`
 * Returns null if nothing could be resolved. Shared by the Docker provisioning path
 * and the compute pre-checks (initialize/start) so persistent-storage ACL validation
 * sees the same resolved object.
 */
export async function resolveComputeFileObject(
  item: ComputeAsset | ComputeAlgorithm
): Promise<BaseFileObject | null> {
  try {
    if (item.fileObject) {
      // plaintext: type is directly available
      if ((item.fileObject as BaseFileObject).type) {
        return item.fileObject as BaseFileObject
      }
      // encrypted: decrypt to reveal the type
      return await decryptFilesObject(item.fileObject)
    }
    // no file object: try documentId + serviceId
    const { documentId, serviceId } = item
    if (documentId && serviceId) {
      const ddo = await new FindDdoHandler(OceanNode.getInstance()).findAndFormatDdo(
        documentId
      )
      if (!ddo) {
        return null
      }
      const service: Service = AssetUtils.getServiceById(ddo, serviceId)
      if (!service) {
        return null
      }
      return await decryptFilesObject(service.files)
    }
    return null
  } catch (e) {
    CORE_LOGGER.error(
      `Unable to resolve compute file object: ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

export function getAlgorithmImage(algorithm: ComputeAlgorithm, jobId: string): string {
  if (!algorithm.meta || !algorithm.meta.container) {
    return null
  }
  if (algorithm.meta.container.dockerfile) {
    return jobId.toLowerCase() + '-image:latest'
  }
  let { image } = algorithm.meta.container
  if (algorithm.meta.container.checksum)
    image = image + '@' + algorithm.meta.container.checksum
  else if (algorithm.meta.container.tag)
    image = image + ':' + algorithm.meta.container.tag
  else image = image + ':latest'
  // console.log('Using image: ' + image)
  return image
}

export function checkManifestPlatform(
  manifestPlatform: any,
  envPlatform?: RunningPlatform
): boolean {
  if (!manifestPlatform || !envPlatform) return true // skips if not present
  if (envPlatform.architecture === 'amd64') envPlatform.architecture = 'x86_64' // x86_64 is compatible with amd64
  if (manifestPlatform.architecture === 'amd64') manifestPlatform.architecture = 'x86_64' // x86_64 is compatible with amd64

  if (
    envPlatform.architecture !== manifestPlatform.architecture ||
    envPlatform.os !== manifestPlatform.os
  )
    return false
  return true
}
