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

export * from './getOceanPeers.js'

export const httpRoutes = express.Router()

// P2P routes related
export const hasP2PInterface = await (await getConfiguration()).hasP2P
export function sendMissingP2PResponse(res: Response) {
  res.status(400).send('Invalid or Non Existing P2P configuration')
}

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
