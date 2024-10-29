import { Readable } from 'stream'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput,
  DBComputeJob
} from '../../@types/C2D/C2D.js'
import { C2DClusterType } from '../../@types/C2D/C2D.js'

export abstract class C2DEngine {
  private clusterConfig: C2DClusterInfo
  public constructor(cluster: C2DClusterInfo) {
    this.clusterConfig = cluster
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
    throw new Error('Method not implemented.')
  }

  // overwritten by classes for cleanup
  public stop(): Promise<void> {
    throw new Error('Method not implemented.')
  }

  public abstract startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    environment: string,
    owner?: string,
    validUntil?: number,
    chainId?: number,
    agreementId?: string
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
}

export class C2DEngineLocal extends C2DEngine {
  public getComputeEnvironments(chainId?: number): Promise<ComputeEnvironment[]> {
    throw new Error('Method not implemented.')
  }

  public startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    environment: string,
    owner?: string,
    validUntil?: number,
    chainId?: number,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    throw new Error('Method not implemented.')
  }

  public stopComputeJob(
    jobId: string,
    owner: string,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    throw new Error('Method not implemented.')
  }

  public getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    throw new Error('Method not implemented.')
  }

  public getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<Readable> {
    throw new Error('Method not implemented.')
  }

  public cleanupExpiredStorage(job: DBComputeJob): Promise<boolean> {
    throw new Error('Method not implemented.')
  }

  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig)
  }
  // not implemented yet
}
