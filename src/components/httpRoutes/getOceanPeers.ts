
import express, { Request, Response } from 'express';
import { Get, Route } from "tsoa";
import { CustomNodeLogger, 
    LOGGER_MODULE_NAMES, 
    getCustomLoggerForModule, 
    getDefaultLevel} from '../../utils/logging/Logger';

//we could just use the default logger with default transports
//and/or we could also create a Factory for different modules/components on '../../utils/logging/Logger'
// const customLogger: CustomNodeLogger = new CustomNodeLogger(/*pass any custom options here*/ {
//     level: LOG_LEVELS.LEVEL_HTTP,
//     levels: LEVELS,
//     moduleName: LOGGER_MODULE_NAMES.P2P,
//     transports: [ buildCustomFileTransport(LOGGER_MODULE_NAMES.P2P),defaultConsoleTransport]
// });

const customLogger: CustomNodeLogger = getCustomLoggerForModule(LOGGER_MODULE_NAMES.P2P, getDefaultLevel());

export const getOceanPeersRoute = express.Router();
getOceanPeersRoute.get('/getOceanPeers', async (req: Request, res: Response): Promise<void> => {

    const peers=await req.oceanNode.node.getPeers()
    customLogger.getLogger().log(getDefaultLevel(),`getOceanPeers: ${peers}`);
    res.json(peers);
  
});

export const getP2PPeersRoute = express.Router();
getP2PPeersRoute.get('/getP2PPeers', async (req: Request, res: Response): Promise<void> => {

    const peers=await req.oceanNode.node.getAllPeerStore()
    res.json(peers);
  
});

export const getP2PPeerRoute = express.Router();
getP2PPeersRoute.get('/getP2PPeer', express.urlencoded({ extended: true }),async (req: Request, res: Response): Promise<void> => {
    if(!req.query.peerId){
        res.sendStatus(400)
        return
    }
    const peers=await req.oceanNode.node.getPeerDetails(String(req.query.peerId))
    res.json(peers);
  
});