import {
  C2DClusterInfo,
  C2DClusterType,
  ComputeEnvironment
} from '../../@types/C2D/C2D.js'
import { C2DEngine } from './compute_engine_base.js'
import { C2DEngineDocker } from './compute_engine_docker.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { C2DDatabase } from '../database/C2DDatabase.js'
import { Escrow } from '../core/utils/escrow.js'
import { KeyManager } from '../KeyManager/index.js'
import { CORE_LOGGER } from '../../utils/logging/common.js'

export class C2DEngines {
  public engines: C2DEngine[]
  public constructor(
    config: OceanNodeConfig,
    db: C2DDatabase,
    escrow: Escrow,
    keyManager: KeyManager
  ) {
    const crons = {
      imageCleanup: false,
      scanDBUpdate: false
    }
    if (config && config.c2dClusters) {
      this.engines = []
      let cpuOffset = 0
      for (const cluster of config.c2dClusters) {
        if (cluster.type === C2DClusterType.DOCKER) {
          // do some checks
          const limit = 6
          const claimDurationTimeout = escrow.getMinLockTime(0)
          if (cluster.connection.paymentClaimInterval * limit > claimDurationTimeout) {
            CORE_LOGGER.error(
              `Cannot create engine ${cluster.connection.hash}.\r\nConfig.claimDurationTimeout is not high enough to claim at least ${limit} times. Either decrease environment.paymentClaimInterval${cluster.connection.paymentClaimInterval} or increase config.claimDurationTimeout(${claimDurationTimeout})`
            )
          } else {
            const cfg = JSON.parse(JSON.stringify(cluster)) as C2DClusterInfo
            // make sure that crons are running only on one docker engine
            if (crons.imageCleanup) {
              // already running, set cron to null for this engine
              cfg.connection.imageCleanupInterval = null
            } else {
              // not running yet, set the defaults
              cfg.connection.imageCleanupInterval =
                cfg.connection.imageCleanupInterval || 86400 // 24 hours
              crons.imageCleanup = true
            }
            if (crons.scanDBUpdate) {
              cfg.connection.scanImageDBUpdateInterval = null
            } else {
              if (cfg.connection.scanImages) {
                // set the defaults
                cfg.connection.scanImageDBUpdateInterval =
                  cfg.connection.scanImageDBUpdateInterval || 43200 // 12 hours
                crons.scanDBUpdate = true
              } else {
                // image scanning disabled for this engine
                cfg.connection.scanImageDBUpdateInterval = null
              }
            }
            this.engines.push(
              new C2DEngineDocker(
                cfg,
                db,
                escrow,
                keyManager,
                config.dockerRegistrysAuth,
                cpuOffset
              )
            )
          }
          // Advance the CPU offset by this cluster's configured CPU total
          if (cluster.connection?.resources) {
            const cpuRes = cluster.connection.resources.find((r: any) => r.id === 'cpu')
            if (cpuRes?.total) {
              cpuOffset += cpuRes.total
            }
          }
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

  async getC2DByEnvId(envId: string): Promise<C2DEngine> {
    /**
     * Searches all envs and returns engine class
     *
     * @param envId - Environment Id
     *
     */
    const { engines } = this
    for (const i of engines) {
      const environments = await i.getComputeEnvironments()
      for (const env of environments) {
        if (env.id === envId) return i
      }
    }
    throw new Error(`C2D Engine not found by id: ${envId}`)
  }

  async fetchEnvironments(
    chainId?: number,
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
