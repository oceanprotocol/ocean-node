import { OceanNode } from '../../OceanNode.js'
import type {
  C2DClusterInfo,
  ComputeEnvironment,
  ComputeAlgorithm,
  ComputeAsset,
  ComputeJob,
  ComputeOutput,
  ComputeResult,
  ComputeResultType,
  OPFK8ComputeOutput,
  OPFK8ComputeStage,
  OPFK8ComputeStageAlgorithm,
  OPFK8ComputeStageInput,
  OPFK8ComputeWorkflow,
  OPFK8ComputeStart
} from '../../@types/C2D.js'
import { C2DClusterType } from '../../@types/C2D.js'
import { sign } from '../core/utils/nonceHandler.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'
import axios from 'axios'
import { getConfiguration } from '../../utils/config.js'
import { GetEnvironmentsHandler } from '../core/compute.js'

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
  public async getComputeEnvironments(chainId: number): Promise<ComputeEnvironment[]> {
    throw new Error(`Not implemented`)
  }

  public async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    owner: string,
    environment: string,
    validUntil: number,
    chainId: number
  ): Promise<string> {
    throw new Error(`Not implemented`)
  }
}

export class C2DEngineOPFK8 extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig)
  }

  public override async getComputeEnvironments(
    chainId: number
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    const envs: ComputeEnvironment[] = []
    const clusterHash = this.getC2DConfig().hash
    const url = `${
      this.getC2DConfig().url
    }api/v1/operator/environments?chain_id=${chainId}`
    try {
      const { data } = await axios.get(url)
      // we need to add hash to each env id
      for (const [index, val] of data.entries()) {
        data[index].id = `${clusterHash}-${val.id}`
      }
      return data
    } catch {}
    return envs
  }

  public override async startComputeJob(
    assets: ComputeAsset[],
    algorithm: ComputeAlgorithm,
    output: ComputeOutput,
    owner: string,
    environment: string,
    validUntil: number,
    chainId: number
  ): Promise<string> {
    // let's build the stage first
    // start with stage.input
    const stagesInput: OPFK8ComputeStageInput[] = []
    let index = 0
    for (const asset of assets) {
      if (asset.url)
        stagesInput.push({
          index,
          url: [asset.url]
        })
      else
        stagesInput.push({
          index,
          id: asset.documentId
        })
      index++
    }
    // continue with algorithm
    const stageAlgorithm: OPFK8ComputeStageAlgorithm = {}
    if (algorithm.url) stageAlgorithm.url = algorithm.url
    if (algorithm.documentId) stageAlgorithm.id = algorithm.documentId
    if (algorithm.meta.rawcode) stageAlgorithm.rawcode = algorithm.meta.rawcode
    if (algorithm.meta.container) stageAlgorithm.container = algorithm.meta.container
    const stage: OPFK8ComputeStage = {
      index: 0,
      input: stagesInput,
      algorithm: stageAlgorithm,
      output
    }
    // now, let's build the workflow
    const workflow: OPFK8ComputeWorkflow = {
      stages: [stage]
    }
    // and the full payload
    const nonce: number = new Date().getTime()
    const config = await getConfiguration()

    const providerSignature = await sign(String(nonce), config.keys.privateKey)
    const payload: OPFK8ComputeStart = {
      workflow,
      owner,
      providerSignature,
      providerAddress: config.keys.ethAddress,
      environment,
      validUntil,
      nonce,
      chainId
    }
    // and send it to remote op-service
    const url = `${this.getC2DConfig().url}api/v1/operator/compute`
    try {
      const jobId = await axios.post(url, payload)
      const { hash } = this.getC2DConfig()
      // we need to prepend cluster hash to jobId
      return hash + '-' + jobId
    } catch {}
    throw new Error(`startCompute Failure`)
  }
}

export class C2DEngineLocal extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig)
  }
  // not implemented yet
}
