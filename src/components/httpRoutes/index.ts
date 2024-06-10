import express, { Response } from 'express'
import { getOceanPeersRoute, getP2PPeersRoute, getP2PPeerRoute } from './getOceanPeers.js'
import { advertiseDidRoute, getProvidersForDidRoute } from './dids.js'
import { broadcastCommandRoute, directCommandRoute } from './commands.js'
import { logRoutes } from './logs.js'
import { providerRoutes } from './provider.js'
import { aquariusRoutes } from './aquarius.js'
import { rootEndpointRoutes } from './rootEndpoint.js'
import { fileInfoRoute } from './fileInfo.js'
import { computeRoutes } from './compute.js'
import { queueRoutes } from './queue.js'
import { getConfiguration } from '../../utils/config.js'
import { jobsRoutes } from './jobs.js'

export * from './getOceanPeers.js'

export const httpRoutes = express.Router()

// P2P routes related
export const hasP2PInterface = (await (await getConfiguration())?.hasP2P) || false

export function sendMissingP2PResponse(res: Response) {
  res.status(400).send('Invalid or Non Existing P2P configuration')
}

export const allRoutesMapping = new Map<string, string[]>()
// /getOceanPeers
httpRoutes.use(getOceanPeersRoute)
// /getP2PPeers
httpRoutes.use(getP2PPeersRoute)
// /getP2PPeer
httpRoutes.use(getP2PPeerRoute)
// /advertiseDid
httpRoutes.use(advertiseDidRoute)
// /getProvidersForDid
httpRoutes.use(getProvidersForDidRoute)
// /broadcastCommand
httpRoutes.use(broadcastCommandRoute)
// /directCommand
httpRoutes.use(directCommandRoute)
// /logs
// /log/:id
httpRoutes.use(logRoutes)
// /api/fileinfo
httpRoutes.use(fileInfoRoute)
// /api/services/decrypt
// /api/services/encrypt
// /api/services/download
// /api/services/initialize
// /api/services/nonce
httpRoutes.use(providerRoutes)
// /api/aquarius/assets/ddo/:did
// /api/aquarius/assets/metadata/:did
// /api/aquarius/assets/metadata/query
// /api/aquarius/state/ddo
// /api/aquarius/assets/ddo/validate
httpRoutes.use(aquariusRoutes)
httpRoutes.use(rootEndpointRoutes)
// /api/services/computeEnvironments
httpRoutes.use(computeRoutes)
// queue routes
httpRoutes.use(queueRoutes)
// running jobs
httpRoutes.use(jobsRoutes)

function addMapping(path: any, layer: any) {
  if (layer.route) {
    layer.route.stack.forEach(addMapping.bind(null, path.concat(split(layer.route.path))))
  } else if (layer.name === 'router' && layer.handle.stack) {
    layer.handle.stack.forEach(addMapping.bind(null, path.concat(split(layer.regexp))))
  } else if (layer.method) {
    const method = layer.method.toUpperCase()
    const pathName = '/' + path.concat(split(layer.regexp)).filter(Boolean).join('/')
    if (allRoutesMapping.has(pathName)) {
      const existingData = allRoutesMapping.get(pathName)
      if (existingData[0] !== method) {
        // add with a new name
        const name = pathName + '_' + method
        allRoutesMapping.set(name, [method, pathName])
      }
    } else {
      allRoutesMapping.set(pathName, [method, pathName])
    }
  }
}

function split(thing: any) {
  if (typeof thing === 'string') {
    return thing.split('/')
  } else if (thing.fast_slash) {
    return ''
  } else {
    const match = thing
      .toString()
      .replace('\\/?', '')
      .replace('(?=\\/|$)', '$')
      .match(/^\/\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\/])*)\$\//)
    return match
      ? match[1].replace(/\\(.)/g, '$1').split('/')
      : '<complex:' + thing.toString() + '>'
  }
}

export function getAllServiceEndpoints() {
  httpRoutes.stack.forEach(addMapping.bind(null, []))
  const data: any = {}
  const keys = allRoutesMapping.keys()
  for (const key of keys) {
    data[key] = allRoutesMapping.get(key)
  }
  // console.log('DATA:', data)
  return data
}
