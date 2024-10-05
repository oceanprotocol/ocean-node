import { Readable } from 'stream'
import { C2DClusterType } from '../../@types/C2D/C2D.js'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput
} from '../../@types/C2D/C2D.js'
import { ZeroAddress } from 'ethers'
// import { getProviderFeeToken } from '../../components/core/utils/feesHandler.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DDatabase } from '../database/index.js'
import { create256Hash } from '../../utils/crypt.js'
export class C2DEngineDocker extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  private envs: ComputeEnvironment[] = []
  private db: C2DDatabase
  public constructor(clusterConfig: C2DClusterInfo, db: C2DDatabase) {
    super(clusterConfig)
    this.db = db

    // TO DO C2D - create envs
  }

  // eslint-disable-next-line require-await
  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */

    return this.envs
  }

  // eslint-disable-next-line require-await
  public override async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    environment: string,
    owner?: string,
    validUntil?: number,
    chainId?: number,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    return null
  }

  // eslint-disable-next-line require-await
  public override async stopComputeJob(
    jobId: string,
    owner: string,
    agreementId?: string
  ): Promise<ComputeJob[]> {
    return null
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobStatus(
    consumerAddress?: string,
    agreementId?: string,
    jobId?: string
  ): Promise<ComputeJob[]> {
    return null
  }

  // eslint-disable-next-line require-await
  public override async getComputeJobResult(
    consumerAddress: string,
    jobId: string,
    index: number
  ): Promise<Readable> {
    return null
  }

  private async InternalLoop() {
    // this is the internal loop of docker engine
    // has to :
    //  - monitor running containers and stop them if over limits
    //  - monitor disc space and clean up
  }
}

// this uses the docker engine, but exposes only one env, the free one
export class C2DEngineDockerFree extends C2DEngineDocker {
  public constructor(clusterConfig: C2DClusterInfo, db: C2DDatabase) {
    // we remove envs, cause we have our own
    const owerwrite = {
      type: C2DClusterType.DOCKER,
      hash: create256Hash('free' + clusterConfig.hash),
      connection: {
        socketPath: clusterConfig.connection.socketPath,
        protocol: clusterConfig.connection.protocol,
        host: clusterConfig.connection.host,
        port: clusterConfig.connection.port,
        caPath: clusterConfig.connection.caPath,
        certPath: clusterConfig.connection.certPath,
        keyPath: clusterConfig.connection.keyPath
      }
    }
    super(owerwrite, db)
  }

  // eslint-disable-next-line require-await
  public override async getComputeEnvironments(
    chainId?: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    // TO DO C2D - fill consts below
    const cpuType = ''
    const currentJobs = 0
    const consumerAddress = ''
    const envs: ComputeEnvironment[] = [
      {
        id: `${this.getC2DConfig().hash}-free`,
        cpuNumber: 1,
        cpuType,
        gpuNumber: 0,
        ramGB: 1,
        diskGB: 1,
        priceMin: 0,
        desc: 'Free',
        currentJobs,
        maxJobs: 1,
        consumerAddress,
        storageExpiry: 600,
        maxJobDuration: 60,
        feeToken: ZeroAddress,
        free: true
      }
    ]
    return envs
  }
}
