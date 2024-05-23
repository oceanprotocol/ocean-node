import { C2DEngine } from '../../c2d/compute_engines.js'
import { ComputeEnvironment } from '../../../@types/C2D.js'
export async function fetchEnvironments(
  chainId: number,
  engine: C2DEngine
): Promise<ComputeEnvironment[]> {
  const response: ComputeEnvironment[] = []
  const environments = await engine.getComputeEnvironments(chainId)
  response.push(...environments)
  return response
}
