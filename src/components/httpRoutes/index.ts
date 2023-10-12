import express from 'express';
import {getOceanPeersRoute,getP2PPeersRoute} from './getOceanPeers'
import {advertiseDidRoute,getProvidersForDidRoute} from './dids'
import {broadcastCommandRoute,directCommandRoute} from './commands'
export * from './getOceanPeers'



export const httpRoutes = express.Router();

httpRoutes.use(getOceanPeersRoute);
httpRoutes.use(getP2PPeersRoute);
httpRoutes.use(advertiseDidRoute);
httpRoutes.use(getProvidersForDidRoute);
httpRoutes.use(broadcastCommandRoute);
httpRoutes.use(directCommandRoute);