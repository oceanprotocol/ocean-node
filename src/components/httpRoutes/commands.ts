
import express, { Request, Response } from 'express';
import { Get, Route } from "tsoa";

export const broadcastCommandRoute = express.Router();
broadcastCommandRoute.post('/broadcastCommand', express.urlencoded({ extended: true }),async (req: Request, res: Response): Promise<void> => {
    if(!req.query.message){
        res.sendStatus(400)
        return
    }

    await req.oceanNode.node.broadcast(req.query.message)
    res.sendStatus(200)
  
});

export const directCommandRoute = express.Router();
directCommandRoute.post('/directCommand', express.urlencoded({ extended: true }),async (req: Request, res: Response): Promise<void> => {
    console.log(req.body)
    if(!req.query.message || !req.query.node){
        res.sendStatus(400)
        return
    }

    await req.oceanNode.node.sendTo(req.query.node as string, req.query.message,null)
    res.sendStatus(200)
  
});