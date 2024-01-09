import express from 'express'
import { getOceanPeersRoute, getP2PPeersRoute, getP2PPeerRoute } from './getOceanPeers.js'
import { advertiseDidRoute, getProvidersForDidRoute } from './dids.js'
import { broadcastCommandRoute, directCommandRoute } from './commands.js'
import { logRoutes } from './logs.js'
import { providerRoutes } from './provider.js'
import { aquariusRoutes } from './aquarius.js'
import { rootEndpointRoutes } from './rootEndpoint.js'
import { downloadRoute } from './download.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from '../../utils/logging/Logger.js'

export * from './getOceanPeers.js'

export const httpRoutes = express.Router()
// use this logger instance on all HTTP related stuff
export const HTTP_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO,
  defaultConsoleTransport
)

httpRoutes.use(getOceanPeersRoute)
httpRoutes.use(getP2PPeersRoute)
httpRoutes.use(getP2PPeerRoute)
httpRoutes.use(advertiseDidRoute)
httpRoutes.use(getProvidersForDidRoute)
httpRoutes.use(broadcastCommandRoute)
httpRoutes.use(directCommandRoute)
httpRoutes.use(logRoutes)
httpRoutes.use(downloadRoute)
httpRoutes.use('/api/services/', providerRoutes)
httpRoutes.use('/api/aquarius/', aquariusRoutes)
httpRoutes.use(rootEndpointRoutes)
