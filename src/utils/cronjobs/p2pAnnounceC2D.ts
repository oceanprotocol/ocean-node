import { OceanNode } from '../../OceanNode.js'
import { OCEAN_NODE_LOGGER } from '../logging/common.js'
import { provideLimit } from '../../components/P2P/provideLimiter.js'
import { c2dCapabilityContent } from '../../components/P2P/c2dCapability.js'

/**
 * The name a resource is announced under: whatever the engine reports in `type` (the "hint
 * string used for grouping and display" — `cpu`, `ram`, `disk`, `gpu`, `fpga`, ...), falling
 * back to `id` when `type` is absent. This is deliberately not a closed set: nothing here
 * knows the difference between `cpu` and an accelerator type nobody has heard of yet, and
 * that is what lets a brand new resource announce correctly without a code change.
 */
function resourceName(resource: any): string | undefined {
  if (typeof resource?.type === 'string' && resource.type.length > 0) {
    return resource.type
  }
  if (typeof resource?.id === 'string' && resource.id.length > 0) {
    return resource.id
  }
  return undefined
}

/**
 * Every bucket at or below `max`, in the resource's own unit: `1, 2, 4, 8, ...` up to (and
 * including, if it is itself a power of two) `max`. A node with `cpu.max = 8` announces
 * buckets 1, 2, 4, 8 — four strings, not eight, and never a value above its true maximum.
 */
function bucketsUpTo(max: number): number[] {
  const buckets: number[] = []
  let bucket = 1
  while (bucket <= max) {
    buckets.push(bucket)
    bucket *= 2
  }
  return buckets
}

/**
 * Walks one flat list of resolved resources (either an environment's paid `resources` or its
 * `free.resources` — both are fully-resolved `ComputeResource[]` by the time
 * `fetchEnvironments()` returns them, so the two are handled identically) and adds the
 * serialized capability string for every announceable bucket into `capabilities`.
 *
 * This is the single loop that replaces the old switch on `resource.type` with cases for only
 * `cpu`/`gpu` and `ram`/`disk` and no default: that switch silently dropped any other resource
 * an operator configured (`fpga`, `pcie`, ...) with no announcement and no warning. Handling
 * "any resource with an integer max" generically here is what makes a new resource type need
 * no ocean-node release — the compute engine reporting it is the whole change.
 *
 * Units are never converted: `resource.max` is iterated in whatever unit the engine reports it
 * in (cores for cpu, GB for ram/disk, boards/devices for an accelerator). No `resource.model`,
 * `resource.kind` or `resource.description` is ever read here — none of that discriminates the
 * announced string, so there is exactly one capability per (free, bucket) pair, never two.
 */
function collectCapabilities(
  resources: any[] | undefined,
  free: boolean,
  envId: string,
  capabilities: Set<string>
): void {
  if (!resources) return
  for (const resource of resources) {
    const name = resourceName(resource)
    if (!name) {
      OCEAN_NODE_LOGGER.warn(
        `p2pAnnounceC2D: env "${envId}" has a resource with neither "type" nor "id" set; not announced`
      )
      continue
    }
    const { max } = resource ?? {}
    // A resource whose max is absent, non-numeric, non-integer or below 1 is not announced,
    // and the reason is logged — never silently skipped, which is the bug this replaces.
    if (!Number.isInteger(max) || max < 1) {
      OCEAN_NODE_LOGGER.warn(
        `p2pAnnounceC2D: env "${envId}" resource "${name}" has an invalid max (${max}); not announced`
      )
      continue
    }
    for (const bucket of bucketsUpTo(max)) {
      capabilities.add(c2dCapabilityContent({ free, resource: name, value: bucket }))
    }
  }
}

export async function p2pAnnounceC2D(node: OceanNode) {
  try {
    const computeEngines = node.getC2DEngines()
    if (!computeEngines) {
      return
    }
    let result
    try {
      result = await computeEngines.fetchEnvironments()
    } catch (err) {
      OCEAN_NODE_LOGGER.error(
        `p2pAnnounceC2D: failed to fetch environments: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }
    // Keyed on the serialized string itself, so the dedupe guard is trivially correct: two
    // resources (or a paid and a free resource sharing a bucket) that would otherwise produce
    // the same bytes collapse into a single announcement, instead of comparing object
    // references that are never equal.
    const capabilities = new Set<string>()
    for (const env of result) {
      collectCapabilities(env.resources, false, env.id, capabilities)
      if (env.free?.resources) {
        collectCapabilities(env.free.resources, true, env.id, capabilities)
      }
    }
    const p2p = node.getP2PNode()
    if (!p2p) {
      return
    }
    // bounded concurrency and a real await. The bare `p2p.advertiseString(...)` in a
    // `for` loop launched one un-awaited provide per capability CID, all at once.
    let advertised = 0
    await Promise.all(
      [...capabilities].map((content) =>
        provideLimit(async () => {
          try {
            // false means the provide was not attempted - no DHT peers to write to yet, so
            // the string was queued for a later flush - and must not count as advertised.
            if (await p2p.advertiseString(content)) {
              advertised++
            }
          } catch (err) {
            OCEAN_NODE_LOGGER.error(
              `p2pAnnounceC2D: failed to advertise ${content}: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          }
        })
      )
    )
    // A real count: `advertiseString` rejects on a failed provide, so the catch wrapping it
    // fires and that string is not counted, and it returns false when it only queued.
    OCEAN_NODE_LOGGER.debug(
      `p2pAnnounceC2D: advertised ${advertised}/${capabilities.size} c2d capability strings`
    )
  } catch (err) {
    // The scheduler starts this job fire-and-forget, on boot and on every tick. Anything that
    // escapes here is an unhandled rejection, which is fatal on Node >= 15 - and this process
    // installs an `unhandledRejection` handler that calls `process.exit(1)`, so an announce
    // failure would take the whole node down. Everything except the environment fetch - the
    // engine lookup, the resource range loops, the P2P handle - was outside any handler.
    OCEAN_NODE_LOGGER.error(
      `p2pAnnounceC2D: aborted: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
