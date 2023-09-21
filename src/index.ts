import { OceanP2P } from "./components/P2P/index"
import { OceanProvider } from "./components/Provider/index"
import { OceanIndexer } from "./components/Indexer/index"
import { getRandomInt} from './utils'
import express, { Express, Request, Response } from 'express';
import { OceanNode} from './@types/index'
import swaggerUi from "swagger-ui-express";
import {httpRoutes} from './components/httpRoutes'

let node:any
let oceanNode:OceanNode

const app: Express = express();
//const port = getRandomInt(6000,6500)
let port = parseInt(process.env.PORT)
if(isNaN(port))
  port=8000

declare global {
  namespace Express {
    interface Request {
      oceanNode: OceanNode
    }
  }
}


async function main(){
  const node=new OceanP2P()
  await node.start()
  await node.startListners()
  const indexer = new OceanIndexer()
  const provider = new OceanProvider()
  oceanNode = {
    node: node,
    indexer: indexer,
    provider: provider
  }
  
  app.use((req, res, next) => {
    req.oceanNode = oceanNode;
    next();
  });

  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      swaggerOptions: {
        url: "/swagger.json",
      },
    })
  );
  app.use('/', httpRoutes);
  
  app.listen(port, () => {
    console.log(`HTTP port: ${port}`)
  })
  
  

  /*

  setInterval(
    async () => {
      console.log("Broadcasting something cool...")
      node.broadcast("un text lkjfg kfgdhgihi ihdfgoih fgifhdohfgdh ofyg8ofy goydfhgoyfgof goung")
      //await node.advertiseProviderAddress()
      //const peers=node.getPeers()
      //console.log("Peers:")
      //console.log(peers)
      //if(peers.length>0){
      // console.log("Let's find "+peers[0].toString())
      // await node.getProviders(peers[0].toString())
      //}
      
        

    }
    , getRandomInt(3000,20000))
  */    
}


main()