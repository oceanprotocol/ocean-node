import { OceanNode } from '../../OceanNode.js'
// import { P2P_LOGGER } from '../logging/common.js'
const GB = 1024 * 1024 * 1024 // 1 GB in bytes

export async function p2pAnnounceC2D(node: OceanNode) {
  const announce: any[] = []
  const computeEngines = node.getC2DEngines()
  const result = await computeEngines.fetchEnvironments()
  for (const env of result) {
    for (const resource of env.resources) {
      switch (resource.type) {
        case 'cpu':
        case 'gpu':
          // For CPU and GPU, we assume the min and max are in terms of cores
          // and we generate announcements for each core count in the range
          for (let i = resource.min ? resource.min : 1; i <= resource.max; i++) {
            const obj: Record<string, any> = {}
            obj.free = false
            obj[resource.type] = i
            if (!announce.includes(obj)) {
              announce.push(obj)
            }
            if (resource.type === 'gpu' && resource.kind) {
              obj.description = resource.description // add kind if available
              if (!announce.includes(obj)) {
                announce.push(obj)
              }
            }
          }
          break
        case 'ram':
        case 'disk':
          for (let i = resource.min; i <= resource.max; i += GB) {
            const obj: Record<string, any> = {}
            obj.free = false
            obj[resource.type] = Math.round(i / GB)
            if (!announce.includes(obj) && obj[resource.type] > 0) {
              announce.push(obj)
            }
          }
          break
      }
    }
    for (const resource of env.free.resources) {
      let min = 0
      let kind = null
      let type = null
      // we need to get the min from resources
      for (const res of env.resources) {
        if (res.id === resource.id) {
          ;({ min } = res)
          ;({ kind } = res)
          ;({ type } = res)
        }
      }

      switch (type) {
        case 'cpu':
        case 'gpu':
          // For CPU and GPU, we assume the min and max are in terms of cores
          // and we generate announcements for each core count in the range
          // if min is not defined, we assume it is 1
          for (let i = min || 1; i <= resource.max; i++) {
            const obj: Record<string, any> = {}
            obj.free = true
            obj[type] = i
            if (!announce.includes(obj)) {
              announce.push(obj)
            }
            if (type === 'gpu' && kind) {
              obj.kind = kind // add kind if available
              if (!announce.includes(obj)) {
                announce.push(obj)
              }
            }
          }
          break

        case 'ram':
        case 'disk':
          for (let i = min; i <= resource.max; i += GB) {
            const obj: Record<string, any> = {}
            obj.free = true
            obj[type] = Math.round(i / GB)
            if (!announce.includes(obj) && obj[type] > 0) {
              announce.push(obj)
            }
          }
          break
      }
    }
  }
  // now announce all resources to p2p network
  for (const obj of announce) {
    const res = {
      c2d: obj
    }
    node.getP2PNode().advertiseString(JSON.stringify(res))
  }
}
