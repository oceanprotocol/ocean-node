
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