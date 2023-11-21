import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { Database } from './components/database/index.js'
import express, { Express, Request, Response } from 'express'
import { OceanNode } from './@types/index.js'
import swaggerUi from 'swagger-ui-express'
import { httpRoutes } from './components/httpRoutes/index.js'
import { getConfig } from './utils/index.js'

import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from './utils/logging/Logger.js'
import { Blockchain } from './utils/blockchain.js'
import { RPCS } from './@types/blockchain.js'
import fs from 'fs'
import path from 'path'

// just use the default logger with default transports
// Bellow is just an example usage, only logging to console here, we can customize any transports
// we could create just one logger per module/component, and export/import it between files of the same component/module
// we can also have different log levels, going to different files
const logger: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)

// let node: OceanP2P
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

// we have 5 json examples
// we should have some DDO class too
function loadInitialDDOS(): any[] {
  const ddos: any[] = []
  const dir: string = './data/'
  console.log('LOADING initial', dir)
  for (let i = 1; i < 6; i++) {
    const fileName = `${dir}DDO_example_${i}.json`
    console.log(fileName)
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const rawData = fs.readFileSync(fileName, 'utf8')
      const jsonData = JSON.parse(rawData)
      ddos.push(jsonData)
    } catch (err) {
      console.log(err)
    }
  }
  return ddos
}

async function main() {
  console.log('\n\n\n\n')
  const config = await getConfig()
  if (!config) process.exit(1)
  let node: OceanP2P = null
  let indexer = null
  let provider = null
  const dbconn = await new Database(config.dbConfig)
  if (!process.env.RPCS || !JSON.parse(process.env.RPCS)) {
    // missing or invalid RPC list
    logger.logMessageWithEmoji(
      'Missing or Invalid RPCS env variable format ..',
      true,
      GENERIC_EMOJIS.EMOJI_CROSS_MARK,
      LOG_LEVELS_STR.LEVEl_ERROR
    )
    return
  }
  const supportedNetworks: RPCS = JSON.parse(process.env.RPCS)
  logger.logMessage(`supportedNetworks: ${process.env.RPCS}`)
  const blockchain = new Blockchain(supportedNetworks, config.keys)
  // console.log('signer', blockchainHelper.getSigner())
  if (config.hasP2P) {
    node = new OceanP2P(dbconn, config)
    await node.start()
  }
  if (config.hasIndexer) {
    indexer = new OceanIndexer(dbconn)
    // if we set this var
    // it also loads initial data (useful for testing, or we might actually want to have a bootstrap list)
    // store and advertise DDOs
    if (process.env.LOAD_INITIAL_DDOS) {
      const list = loadInitialDDOS()
      if (list.length > 0) {
        // we need a timeout here, otherwise we have no peers available
        setTimeout(() => {
          node.storeAndAdvertiseDDOS(list)
        }, 3000)
      }
    }
  }
  if (config.hasProvider) provider = new OceanProvider(dbconn)

  // global
  oceanNode = {
    node,
    indexer,
    provider,
    blockchain
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
      logger.logMessage(`HTTP port: ${config.httpPort}`, true)
    })
  }
}

await main()

/**
 * Get the oceanNode instance
 * @returns oceanNode object
 */
const OceanNodeInstance = oceanNode
export default OceanNodeInstance
