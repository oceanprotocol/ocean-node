import { Readable } from 'stream'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput
} from '../../@types/C2D.js'
import { C2DClusterType } from '../../@types/C2D.js'
import { C2DEngineOPFK8 } from './compute_engine_opf_k8.js'
import { getConfiguration } from '../../utils/config.js'

export class C2DEngine {
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

  static async getC2DByHash(
    clusterHash: string
  ): Promise<C2DEngineOPFK8 | C2DEngineLocal> {
    /**
     * Searches the config by c2d engine hash and returns C2D Class. Throws error if not found
     *
     * @param clusterHash - C2D Engine hash
     *
     */
    const clustersInfo: C2DClusterInfo[] = (await getConfiguration()).c2dClusters
    const cluster = clustersInfo.find(({ hash }) => hash === clusterHash)
    if (cluster) {
      return this.getC2DClass(cluster)
    }
    throw new Error(`C2D Engine not found by hash: ${clusterHash}`)
  }

  static getC2DClass(clusterConfig: C2DClusterInfo): C2DEngineOPFK8 | C2DEngineLocal {
    /**
     * Returns C2D Class, based on config. Throws error if not type not supported
     *
     * @param clusterConfig - cluster config
     *
     */
    switch (clusterConfig.type) {
      case C2DClusterType.OPF_K8:
        return new C2DEngineOPFK8(clusterConfig)
      case C2DClusterType.NODE_LOCAL:
        return new C2DEngineLocal(clusterConfig)
      default:
        throw new Error(`Invalid compute engine type: ${clusterConfig.type}`)
    }
  }

  // functions which need to be implemented by all engine types
  // eslint-disable-next-line require-await
  public async getComputeEnvironments(chainId: number): Promise<ComputeEnvironment[]> {
    throw new Error(`Not implemented`)
  }

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

  // eslint-disable-next-line require-await
  public async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    owner: string,
    environment: string,
    validUntil: number,
    chainId: number,
    agreementId: string
  ): Promise<ComputeJob[]> {
    throw new Error(`Not implemented`)
  }

  // eslint-disable-next-line require-await
  public async stopComputeJob(
    jobId: string,
    owner: string,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    throw new Error(`Not implemented`)
  }

  // eslint-disable-next-line require-await
  public async getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    throw new Error(`Not implemented`)
  }

  // eslint-disable-next-line require-await
  public async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<Readable> {
    throw new Error(`Not implemented`)
  }
}

export class C2DEngineLocal extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig)
  }
  // not implemented yet
}
