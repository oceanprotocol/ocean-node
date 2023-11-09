import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { Database } from './components/database/index.js'
import { schemes } from "./components/database/schemes.js";
import express, { Express, Request, Response } from 'express'
import { OceanNode } from './@types/index.js'
import swaggerUi from 'swagger-ui-express'
import { httpRoutes } from './components/httpRoutes/index.js'

import { getConfig } from './utils/index.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from './utils/logging/Logger.js'

// just use the default logger with default transports
// Bellow is just an example usage, only logging to console here, we can customize any transports
// we could create just one logger per module/component, and export/import it between files of the same component/module
// we can also have different log levels, going to different files
const logger: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)

let node: any
let oceanNode: OceanNode

const app: Express = express()
// const port = getRandomInt(6000,6500)

declare global {
  namespace Express {
    interface Request {
      oceanNode: OceanNode
    }
  }
}

async function main() {
  console.log('\n\n\n\n')
  const config = await getConfig()
  if (!config) process.exit(1)
  let node = null
  let indexer = null
  let provider = null
  const db = await new Database(config.dbConfig, schemes)
  const dbconn = db
  if (config.hasP2P) {
    node = new OceanP2P(dbconn, config)
    await node.start()
  }
  if (config.hasIndexer) indexer = new OceanIndexer(dbconn)
  if (config.hasProvider) provider = new OceanProvider(dbconn)

  const oceanNode = {
    node,
    indexer,
    provider
  }
  if (config.hasHttp) {
    app.use((req, res, next) => {
      req.oceanNode = oceanNode
      next()
    })
    app.use(
      '/docs',
      swaggerUi.serve,
      swaggerUi.setup(undefined, {
        swaggerOptions: {
          url: '/swagger.json'
        }
      })
    )
    app.use('/', httpRoutes)
    app.listen(config.httpPort, () => {
      // console.log(`HTTP port: ${config.httpPort}`)
      // other usages example:
      // logger.log(LOG_LEVELS_STR.LEVEL_WARN,`HTTP port: ${config.httpPort}`, true);
      // logger.logMessageWithEmoji(`HTTP port: ${config.httpPort}`, true);
      logger.logMessage(`HTTP port: ${config.httpPort}`, true)
    })
  }
}

main()
