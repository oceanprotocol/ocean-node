import fs from 'fs'
import type { DockerMountObject } from '../../@types/PersistentStorage.js'
import type { ModelCacheMountVerdict, ServiceModelCacheConfig } from './types.js'

// The fixed contract with service images (docs/modelCache.md): the cache's public tree,
// read-only, at this path, announced by this variable.
export const MODEL_CACHE_MOUNT_TARGET = '/ocean/model-cache'
export const MODEL_CACHE_ENV = 'OCEAN_MODEL_CACHE'

export interface ModelCacheMountSource {
  getMountVerdict(): ModelCacheMountVerdict | null
  isMountBroken(): boolean
}

// The read-only bind for a service container, or nothing. Never throws: a missing cache must
// not fail a paid start. Mounts only what the manager last verified (sentinel, local disk,
// no overlap with node data, same path on the host), and only while that directory is still
// the one it verified.
export async function getModelCacheMounts(
  cfg: ServiceModelCacheConfig | undefined,
  source: ModelCacheMountSource | null | undefined
): Promise<DockerMountObject[]> {
  try {
    if (!cfg?.enabled || !source) return []
    const verdict = source.getMountVerdict()
    if (!verdict || verdict.configuredPath !== cfg.path || source.isMountBroken())
      return []
    const st = await fs.promises.lstat(verdict.publicRealpath)
    if (!st.isDirectory() || st.dev !== verdict.dev || st.ino !== verdict.ino) return []
    return [
      {
        Type: 'bind',
        Source: verdict.publicRealpath,
        Target: MODEL_CACHE_MOUNT_TARGET,
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true }
      }
    ]
  } catch {
    return []
  }
}

// A user-supplied value is always dropped, so the variable reliably means "the cache is
// mounted".
export function applyModelCacheEnv(env: Record<string, string>, mounted: boolean): void {
  delete env[MODEL_CACHE_ENV]
  if (mounted) env[MODEL_CACHE_ENV] = MODEL_CACHE_MOUNT_TARGET
}

export function isModelCacheMount(m: DockerMountObject): boolean {
  return m.Target === MODEL_CACHE_MOUNT_TARGET
}
