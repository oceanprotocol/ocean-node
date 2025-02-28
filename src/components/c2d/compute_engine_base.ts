import { Readable } from 'stream'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput,
  ComputeResourceRequest,
  ComputeResourceType,
  ComputeResource,
  DBComputeJob
} from '../../@types/C2D/C2D.js'
import { C2DClusterType } from '../../@types/C2D/C2D.js'
import { C2DDatabase } from '../database/C2DDatabase.js'

export abstract class C2DEngine {
  private clusterConfig: C2DClusterInfo
  public db: C2DDatabase
  public constructor(cluster: C2DClusterInfo, db: C2DDatabase) {
    this.clusterConfig = cluster
    this.db = db
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

  public abstract startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    environment: string,
    owner?: string,
    validUntil?: number,
    chainId?: number,
    agreementId?: string,
    resources?: ComputeResourceRequest[]
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
    index: number
  ): Promise<Readable>

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

    for (const res of env.free.resources) elements.push(res.id)
    for (const res of env.resources) if (!elements.includes(res.id)) elements.push(res.id)

    /* if (isFree && 'free' in env && 'resources' in env.free) {
      for (const res of env.free.resources) elements.push(res.id)
    } else for (const res of env.resources) elements.push(res.id)
      */
    for (const device of elements) {
      let desired = this.getResourceRequest(resources, device)
      const minMax = this.getMaxMinResource(device, env, isFree)
      if (!desired && minMax.min > 0) {
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
      properResources.push({ id: device, amount: minMax.min })
    }

    return properResources
  }

  public async getUsedResources(env: ComputeEnvironment): Promise<any> {
    const usedResources: { [x: string]: any } = {}
    const usedFreeResources: { [x: string]: any } = {}
    const jobs = await this.db.getRunningJobs(this.getC2DConfig().hash)
    let totalJobs = 0
    let totalFreeJobs = 0
    for (const job of jobs) {
      if (job.environment === env.id) {
        totalJobs++
        if (job.isFree) totalFreeJobs++

        for (const resource of job.resources) {
          if (!(resource.id in usedResources)) usedResources[resource.id] = 0
          usedResources[resource.id] += resource.amount
          if (job.isFree) {
            if (!(resource.id in usedFreeResources)) usedFreeResources[resource.id] = 0
            usedFreeResources[resource.id] += resource.amount
          }
        }
      }
    }
    return { totalJobs, totalFreeJobs, usedResources, usedFreeResources }
  }

  // overridden by each engine if required
  // eslint-disable-next-line require-await
  public async checkIfResourcesAreAvailable(
    resourcesRequest: ComputeResourceRequest[],
    env: ComputeEnvironment,
    isFree: boolean
  ) {
    for (const request of resourcesRequest) {
      let envResource = this.getResource(env.resources, request.id)
      if (!envResource) throw new Error(`No such resource ${request.id}`)
      if (envResource.total - envResource.inUse < request.amount)
        throw new Error(`Not enough available ${request.id}`)
      if (isFree) {
        if (!env.free) throw new Error(`No free resources`)
        envResource = this.getResource(env.free.resources, request.id)
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
}
