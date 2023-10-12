import express from 'express';
import {getOceanPeersRoute,getP2PPeersRoute,getP2PPeerRoute} from './getOceanPeers'
import {advertiseDidRoute,getProvidersForDidRoute} from './dids'
import {broadcastCommandRoute,directCommandRoute} from './commands'
export * from './getOceanPeers'



export const httpRoutes = express.Router();

httpRoutes.use(getOceanPeersRoute);
httpRoutes.use(getP2PPeersRoute);
httpRoutes.use(getP2PPeerRoute)
httpRoutes.use(advertiseDidRoute);
httpRoutes.use(getProvidersForDidRoute);
httpRoutes.use(broadcastCommandRoute);
httpRoutes.use(directCommandRoute);