import { C2DClusterType, ComputeEnvironment } from '../../@types/C2D.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DEngineOPFK8 } from './compute_engine_opf_k8.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
export class C2DEngines {
  public engines: C2DEngine[]

  public constructor(config: OceanNodeConfig) {
    // let's see what engines do we have and initialize them one by one
    if (config && config.c2dClusters) {
      this.engines = []
      for (const cluster of config.c2dClusters) {
        if (cluster.type === C2DClusterType.OPF_K8) {
          this.engines.push(new C2DEngineOPFK8(cluster))
        }
      }
    }
  }

  getAllEngines() {
    return this.engines
  }

  async startAllEngines(): Promise<void> {
    for (const engine of this.engines) {
      await engine.start()
    }
    return null
  }

  async stopAllEngines(): Promise<void> {
    for (const engine of this.engines) {
      await engine.stop()
    }
    return null
  }

  async getExactComputeEnv(
    id: string,
    chainId: number
  ): Promise<ComputeEnvironment | null> {
    for (const engine of this.engines) {
      const environments = await engine.getComputeEnvironments(chainId)
      for (const environment of environments) {
        if (environment.id === id) {
          return environment
        }
      }
    }
    return null
  }

  async getC2DByHash(clusterHash: string): Promise<C2DEngine> {
    /**
     * Searches the config by c2d engine hash and returns C2D Class. Throws error if not found
     *
     * @param clusterHash - C2D Engine hash
     *
     */
    for (const engine of this.engines) {
      const engineConfig = await engine.getC2DConfig()
      if (engineConfig.hash === clusterHash) return engine
    }
    throw new Error(`C2D Engine not found by hash: ${clusterHash}`)
  }

  async fetchEnvironments(
    chainId: number,
    engine?: C2DEngine
  ): Promise<ComputeEnvironment[]> {
    /**
     * Returns environments for a specific chainId from all engines or from specific engine
     *
     * @param chainId - cluster config
     * @param engine - optional engine
     *
     */
    const response: ComputeEnvironment[] = []
    let { engines } = this
    if (engine) engines = [engine]
    for (const i of engines) {
      const environments = await i.getComputeEnvironments(chainId)
      response.push(...environments)
    }
    return response
  }
}
