import express, { Response } from 'express'
import { p2pRoutes } from './getOceanPeers.js'
import { advertiseDidRoute, getProvidersForDidRoute } from './dids.js'
import { directCommandRoute } from './commands.js'
import { logRoutes } from './logs.js'
import { providerRoutes } from './provider.js'
import { aquariusRoutes } from './aquarius.js'
import { rootEndpointRoutes } from './rootEndpoint.js'
import { fileInfoRoute } from './fileInfo.js'
import { computeRoutes } from './compute.js'
import { queueRoutes } from './queue.js'
// import { getConfiguration } from '../../utils/config.js'
import { jobsRoutes } from './jobs.js'
import { addMapping, allRoutesMapping, findPathName } from './routeUtils.js'
import { PolicyServerPassthroughRoute } from './policyServer.js'

export * from './getOceanPeers.js'

export const httpRoutes = express.Router()

export function sendMissingP2PResponse(res: Response) {
  res.status(400).send('Invalid or Non Existing P2P configuration')
}

// /p2pRoutes
httpRoutes.use(p2pRoutes)
// /advertiseDid
httpRoutes.use(advertiseDidRoute)
// /getProvidersForDid
httpRoutes.use(getProvidersForDidRoute)
// /directCommand
httpRoutes.use(directCommandRoute)
// /logs
// /log/:id
httpRoutes.use(logRoutes)
// /api/services/fileInfo
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
// policy server passthrough
httpRoutes.use(PolicyServerPassthroughRoute)
export function getAllServiceEndpoints() {
  httpRoutes.stack.forEach(addMapping.bind(null, []))
  const data: any = {}
  const keys = allRoutesMapping.keys()
  for (const key of keys) {
    const pathData = allRoutesMapping.get(key)
    const name = findPathName(pathData[0], pathData[1])
    if (name) {
      data[name] = pathData
    } else {
      // use the key
      data[key] = pathData
    }
  }
  return data
}
