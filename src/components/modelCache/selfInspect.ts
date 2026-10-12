import fs from 'fs'
import os from 'os'
import Dockerode from 'dockerode'
import type { SelfInspection } from './manager.js'

// The container id Docker bind-mounts /etc/hostname, /etc/hosts and /etc/resolv.conf from
// (.../containers/<id>/...), which survives a custom --hostname and host networking.
async function containerIdFromMountinfo(): Promise<string | null> {
  try {
    const info = await fs.promises.readFile('/proc/self/mountinfo', 'utf8')
    return /\/containers\/([0-9a-f]{64})\//.exec(info)?.[1] ?? null
  } catch {
    return null
  }
}

// The node's own container as the host dockerd sees it, so the cache can check that its
// path is bound in at the identical host path. Null only when the node is not
// containerized. A containerized node whose container cannot be found throws: the cache
// then offers no mount rather than mounting a host path it could not check.
export function makeSelfInspector(
  getDocker: () => Dockerode | undefined
): () => Promise<SelfInspection | null> {
  return async () => {
    const containerized = await fs.promises.access('/.dockerenv').then(
      () => true,
      () => false
    )
    if (!containerized) return null
    const docker = getDocker() ?? new Dockerode()
    const candidates = [os.hostname(), await containerIdFromMountinfo()].filter(
      (c): c is string => typeof c === 'string' && c.length > 0
    )
    for (const id of candidates) {
      try {
        const info = await docker.getContainer(id).inspect()
        return {
          Mounts: (info.Mounts ?? []).map((m) => ({
            Source: m.Source,
            Destination: m.Destination,
            RW: m.RW
          }))
        }
      } catch (e) {
        if (e?.statusCode === 404) continue
        throw e
      }
    }
    throw new Error('cannot find the node container on the Docker daemon')
  }
}
