
import express, { Request, Response } from 'express';
import { P2PCommandResponse } from '../../@types';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'

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
directCommandRoute.post('/directCommand', express.json(),async (req: Request, res: Response): Promise<void> => {
    if(!req.body.command || !req.body.node){
        res.sendStatus(400)
        return
    }
    
    const sink = async function (source:any) {
        let first=true
        for await (const chunk of source) {
            if(first){
                first=false
                try{
                    const str=uint8ArrayToString(chunk.subarray())
                    const decoded=JSON.parse(str)
                    res.status(decoded.httpStatus)
                    res.header({'Content-Type': 'text/plain'})
                    res.header({'sdfdsf': 'sdfdsf'})
                    if(decoded.httpStatus!=200){
                        res.write(decoded.error)
                        res.end()
                        break;
                    }

                }
                catch(e){
                    res.status(500)
                    res.write(uint8ArrayToString(chunk.subarray()))
                    res.end()
                }
            }
            else{
                const str=uint8ArrayToString(chunk.subarray())
                res.write(str)
                
            }
        }
        res.end()
    }
    
    const status:P2PCommandResponse =  await req.oceanNode.node.sendTo(req.body.node as string, JSON.stringify(req.body),sink)
    if(status.stream==null){
        res.status(status.status.httpStatus)
        res.write(status.status.error)
        res.end()
        
    }
    
  
});