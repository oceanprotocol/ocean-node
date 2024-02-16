import express, { Response } from 'express'
import { getOceanPeersRoute, getP2PPeersRoute, getP2PPeerRoute } from './getOceanPeers.js'
import { advertiseDidRoute, getProvidersForDidRoute } from './dids.js'
import { broadcastCommandRoute, directCommandRoute } from './commands.js'
import { logRoutes } from './logs.js'
import { providerRoutes } from './provider.js'
import { aquariusRoutes } from './aquarius.js'
import { rootEndpointRoutes } from './rootEndpoint.js'
import { downloadRoute } from './download.js'
import { fileInfoRoute } from './fileInfo.js'
import { computeRoutes } from './compute.js'
import { getConfiguration } from '../../utils/config.js'

export * from './getOceanPeers.js'

export const httpRoutes = express.Router()

// P2P routes related
export const hasP2PInterface = await (await getConfiguration()).hasP2P
export function sendMissingP2PResponse(res: Response) {
  res.status(400).send('Invalid or Non Existing P2P configuration')
}

httpRoutes.use(getOceanPeersRoute)
httpRoutes.use(getP2PPeersRoute)
httpRoutes.use(getP2PPeerRoute)
httpRoutes.use(advertiseDidRoute)
httpRoutes.use(getProvidersForDidRoute)
httpRoutes.use(broadcastCommandRoute)
httpRoutes.use(directCommandRoute)
httpRoutes.use(logRoutes)
httpRoutes.use(downloadRoute)
httpRoutes.use(fileInfoRoute)
httpRoutes.use('/api/services/', providerRoutes)
httpRoutes.use('/api/aquarius/', aquariusRoutes)
httpRoutes.use(rootEndpointRoutes)
httpRoutes.use(computeRoutes)
