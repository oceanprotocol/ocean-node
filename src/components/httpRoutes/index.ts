import express from 'express'
import { getOceanPeersRoute, getP2PPeersRoute, getP2PPeerRoute } from './getOceanPeers.js'
import { advertiseDidRoute, getProvidersForDidRoute } from './dids.js'
import { broadcastCommandRoute, directCommandRoute } from './commands.js'
export * from './getOceanPeers.js'

export const httpRoutes = express.Router()

httpRoutes.use(getOceanPeersRoute)
httpRoutes.use(getP2PPeersRoute)
httpRoutes.use(getP2PPeerRoute)
httpRoutes.use(advertiseDidRoute)
httpRoutes.use(getProvidersForDidRoute)
httpRoutes.use(broadcastCommandRoute)
httpRoutes.use(directCommandRoute)
