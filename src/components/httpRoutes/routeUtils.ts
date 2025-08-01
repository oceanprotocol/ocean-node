import { AQUARIUS_API_BASE_PATH } from './aquarius.js'
import { SERVICES_API_BASE_PATH } from '../../utils/index.js'
import { RouteOptions } from '../../@types/express.js'
// express does not support 'names' or 'descriptions' for routes
// only a path and a method, so if we want a custom name/description (the JSON field), we need to create a mapping of names
// if the name for a path/API is available we use it, otherwise we supply a default one extracted from the path itself
// this way, we always have dynamic routes, even if a route name is not supplied explicitly

// NOTE that none of the bellow is required/mandatory, its just helpful to have more meaningful/pretty names on the response
// we could even use the string to provide a small description instead of just a name/word, for example:

// routesNames.set('computeStart - API that starts a C2D job', {
//   path: `${SERVICES_API_BASE_PATH}/compute`,
//   method: 'post'
// })

// would return:
// {'computeStart - API that starts a C2D job': ['POST','/api/services/compute']}
//
// AND/OR we can also extend RouteOptions in the future and add more fields like a short API description for instance:
// { path, method, description'}:
// Example:
// {'computeStart': ['POST','/api/services/compute','This API allows to start a C2D job]}
//

// C2D
export const routesNames: Map<string, RouteOptions> = new Map<string, RouteOptions>()
export const allRoutesMapping = new Map<string, string[]>()
// these are normalized names for our routes, not mandatory for having dynamic routes, but can add context/detail
routesNames.set('computeEnvironments', {
  path: `${SERVICES_API_BASE_PATH}/computeEnvironments`,
  method: 'get'
})
routesNames.set('computeResult', {
  path: `${SERVICES_API_BASE_PATH}/computeResult`,
  method: 'get'
})

routesNames.set('initializeCompute', {
  path: `${SERVICES_API_BASE_PATH}/initializeCompute`,
  method: 'post'
})

routesNames.set('computeStart', {
  path: `${SERVICES_API_BASE_PATH}/compute`,
  method: 'post'
})

routesNames.set('freeCompute', {
  path: `${SERVICES_API_BASE_PATH}/freeCompute`,
  method: 'post'
})

routesNames.set('computeStreamableLogs', {
  path: `${SERVICES_API_BASE_PATH}/computeStreamableLogs`,
  method: 'GET'
})

routesNames.set('computeStatus', {
  path: `${SERVICES_API_BASE_PATH}/compute`,
  method: 'get'
})

routesNames.set('computeDelete', {
  path: `${SERVICES_API_BASE_PATH}/compute`,
  method: 'delete'
})

routesNames.set('computeStop', {
  path: `${SERVICES_API_BASE_PATH}/compute`,
  method: 'put'
})

// assets / ddo
routesNames.set('getDDO', {
  path: `${AQUARIUS_API_BASE_PATH}/assets/ddo/:did/:force?`,
  method: 'get'
})

routesNames.set('getDDOMetadata', {
  path: `${AQUARIUS_API_BASE_PATH}/assets/metadata/:did/:force?`,
  method: 'get'
})

routesNames.set('ddoMetadataQuery', {
  path: `${AQUARIUS_API_BASE_PATH}/assets/metadata/query`,
  method: 'post'
})

routesNames.set('getDDOState', {
  path: `${AQUARIUS_API_BASE_PATH}/state/ddo`,
  method: 'get'
})

routesNames.set('validateDDO', {
  path: `${AQUARIUS_API_BASE_PATH}/assets/ddo/validate`,
  method: 'post'
})
// direct commands (http + p2p)
routesNames.set('directCommand', {
  path: '/directCommand',
  method: 'post'
})

// fileInfo
routesNames.set('fileInfo', {
  path: `${SERVICES_API_BASE_PATH}/fileInfo`,
  method: 'post'
})
// p2p
routesNames.set('getOceanPeers', {
  path: '/getOceanPeers',
  method: 'get'
})

routesNames.set('getP2PPeers', {
  path: '/getP2PPeers',
  method: 'get'
})

routesNames.set('getP2PPeer', {
  path: '/getP2PPeer',
  method: 'get'
})
// p2p / did
routesNames.set('advertiseDid', {
  path: '/advertiseDid',
  method: 'post'
})

routesNames.set('getProvidersForDid', {
  path: '/getProvidersForDid',
  method: 'get'
})

// logs
routesNames.set('logs', {
  path: '/logs',
  method: 'post'
})

routesNames.set('log', {
  path: '/log/:id',
  method: 'post'
})
// jobs
routesNames.set('jobs', {
  path: `${SERVICES_API_BASE_PATH}/jobs/:job`,
  method: 'get'
})
// provider
routesNames.set('download', {
  path: `${SERVICES_API_BASE_PATH}/download`,
  method: 'get'
})

routesNames.set('encrypt', {
  path: `${SERVICES_API_BASE_PATH}/encrypt`,
  method: 'post'
})

routesNames.set('decrypt', {
  path: `${SERVICES_API_BASE_PATH}/decrypt`,
  method: 'post'
})

routesNames.set('encryptFile', {
  path: `${SERVICES_API_BASE_PATH}/encryptFile`,
  method: 'post'
})

routesNames.set('initialize', {
  path: `${SERVICES_API_BASE_PATH}/initialize`,
  method: 'get'
})

routesNames.set('nonce', {
  path: `${SERVICES_API_BASE_PATH}/nonce`,
  method: 'get'
})

routesNames.set('indexQueue', {
  path: `${SERVICES_API_BASE_PATH}/indexQueue`,
  method: 'get'
})

routesNames.set('PolicyServerPassthrough', {
  path: `${SERVICES_API_BASE_PATH}/PolicyServerPassthrough`,
  method: 'post'
})

routesNames.set('initializePSVerification', {
  path: `${SERVICES_API_BASE_PATH}/initializePSVerification`,
  method: 'post'
})

routesNames.set('generateAuthToken', {
  path: `${SERVICES_API_BASE_PATH}/auth/token`,
  method: 'post'
})

routesNames.set('invalidateAuthToken', {
  path: `${SERVICES_API_BASE_PATH}/auth/token/invalidate`,
  method: 'post'
})

export function addMapping(path: any, layer: any) {
  if (layer.route) {
    layer.route.stack.forEach(addMapping.bind(null, path.concat(split(layer.route.path))))
  } else if (layer.name === 'router' && layer.handle.stack) {
    layer.handle.stack.forEach(addMapping.bind(null, path.concat(split(layer.regexp))))
  } else if (layer.method) {
    const method = layer.method.toUpperCase()
    const pathName = '/' + path.concat(split(layer.regexp)).filter(Boolean).join('/')
    // skip the root path
    if (pathName.length > 1 && pathName !== '/') {
      if (allRoutesMapping.has(pathName)) {
        const existingData = allRoutesMapping.get(pathName)
        if (existingData[0] !== method) {
          // add with a new name
          const defaultName = pathName + '_' + method
          allRoutesMapping.set(defaultName, [method, pathName])
        }
      } else {
        allRoutesMapping.set(pathName, [method, pathName])
      }
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

/**
 *
 * @param method http method
 * @param path path to find
 * @returns path name or null
 */
export function findPathName(method: string, path: string): string | null {
  const entries = routesNames.entries()
  for (const entry of entries) {
    const data: RouteOptions = entry[1]
    if (data.path === path && data.method.toUpperCase() === method) {
      return entry[0]
    }
  }

  return null
}
