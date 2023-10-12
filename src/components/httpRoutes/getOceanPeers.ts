
import express, { Request, Response } from 'express';
import { Get, Route } from "tsoa";


export const getOceanPeersRoute = express.Router();
getOceanPeersRoute.get('/getOceanPeers', async (req: Request, res: Response): Promise<void> => {

    const peers=await req.oceanNode.node.getPeers()
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