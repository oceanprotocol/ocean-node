import { ComputeEnvironment } from '../../../@types/C2D.js'
import { getConfiguration } from '../../../utils/config.js'
import { C2DEngine } from '../../c2d/compute_engines.js'

export async function getExactComputeEnv(
  id: string,
  chainId: number
): Promise<ComputeEnvironment | null> {
  const config = await getConfiguration()
  const { c2dClusters } = config

  for (const cluster of c2dClusters) {
    const engine = C2DEngine.getC2DClass(cluster)
    const environments = await engine.getComputeEnvironments(chainId)
    for (const environment of environments) {
      if (environment.id === id) {
        return environment
      }
    }
  }
  return null
}
