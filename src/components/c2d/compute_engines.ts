import { OceanNode } from '../../OceanNode.js'
import type { C2DClusterInfo, C2DEnvironment } from '../../@types/C2D.js'
import { C2DClusterType } from '../../@types/C2D.js'
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

  static async getC2DByHash(hash: string): Promise<C2DEngineOPFK8 | C2DEngineLocal> {
    /**
     * Searches the config by c2d engine hash and returns C2D Class. Throws error if not found
     *
     * @param hash - C2D Engine hash
     * */
    const clustersInfo: C2DClusterInfo[] = (await getConfiguration()).c2dClusters
    throw new Error(`C2D Engine not found by hash: ${hash}`)
  }

  static getC2DClass(clusterConfig: C2DClusterInfo): C2DEngineOPFK8 | C2DEngineLocal {
    /**
     * Returns C2D Class, based on config. Throws error if not type not supported
     *
     * @param clusterConfig - cluster config
     * */
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
  public async getComputeEnvironments(chainId: number): Promise<C2DEnvironment[]> {
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
  ): Promise<C2DEnvironment[]> {
    /**
     * Returns all cluster's compute environments for a specific chainId. Env's id already contains the cluster hash
     */
    const envs: C2DEnvironment[] = []
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
}

export class C2DEngineLocal extends C2DEngine {
  // eslint-disable-next-line no-useless-constructor
  public constructor(clusterConfig: C2DClusterInfo) {
    super(clusterConfig)
  }
  // not implemented yet
}
