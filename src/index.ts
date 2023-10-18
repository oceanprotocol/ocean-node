import { OceanP2P } from "./components/P2P/index"
import { OceanProvider } from "./components/Provider/index"
import { OceanIndexer } from "./components/Indexer/index"
import { Database } from "./components/database/index"
import express, { Express, Request, Response } from 'express';
import { OceanNode} from './@types/index'
import swaggerUi from "swagger-ui-express";
import {httpRoutes} from './components/httpRoutes'
import {getConfig} from './utils'


import { CustomNodeLogger, 
  LOGGER_MODULE_NAMES, 
  LOG_LEVELS_STR, 
  defaultConsoleTransport, 
  getCustomLoggerForModule } from './utils/logging/Logger';

//just use the default logger with default transports
//Bellow is just an example usage, only logging to console here, we can customize any transports
const logger: CustomNodeLogger = getCustomLoggerForModule(LOGGER_MODULE_NAMES.HTTP, LOG_LEVELS_STR.LEVEL_INFO, defaultConsoleTransport);


let node:any
let oceanNode:OceanNode

const app: Express = express();
//const port = getRandomInt(6000,6500)


declare global {
  namespace Express {
    interface Request {
      oceanNode: OceanNode
    }
  }
}


async function main(){
  console.log("\n\n\n\n")
  const config = await getConfig()
  let node=null
  let indexer=null
  let provider=null
  let dbconn=new Database(config.dbConfig)
  if (config.hasP2P){
    node=new OceanP2P(dbconn)
    await node.start()
  }
  if(config.hasIndexer)
    indexer = new OceanIndexer(dbconn)
  if(config.hasProvider)
    provider = new OceanProvider(dbconn)
  
  const oceanNode = {
    node: node,
    indexer: indexer,
    provider: provider
  }
  if(config.hasHttp){
      app.use((req, res, next) => {req.oceanNode = oceanNode; next(); });
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
      app.listen(config.httpPort, () => {
          //console.log(`HTTP port: ${config.httpPort}`)
          //other usage example: 
          //logger.log(LOG_LEVELS_STR.LEVEL_WARN,`HTTP port: ${config.httpPort}`, true);
          logger.logMessage(`HTTP port: ${config.httpPort}`, true);
      })
  }
  
    
}


main()