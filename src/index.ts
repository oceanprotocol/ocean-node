import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { Database } from './components/database/index.js'
import express, { Express } from 'express'
import { OCEAN_NODE_LOGGER, OceanNode } from './OceanNode.js'
import swaggerUi from 'swagger-ui-express'
import { httpRoutes } from './components/httpRoutes/index.js'
import { getConfig } from './utils/index.js'
import { getSchemasFromTtl } from 'shacl-jsonschema-converter'

import {
  GENERIC_EMOJIS,
  LOG_LEVELS_STR,
  newCustomDBTransport
} from './utils/logging/Logger.js'
import fs from 'fs'

// just use the default logger with default transports
// Bellow is just an example usage, only logging to console here, we can customize any transports
// we could create just one logger per module/component, and export/import it between files of the same component/module
// we can also have different log levels, going to different files

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
  for (let i = 1; i < 6; i++) {
    const fileName = `${dir}DDO_example_${i}.json`
    OCEAN_NODE_LOGGER.logMessage(`Loading test DDO from ${fileName}`, true)
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const rawData = fs.readFileSync(fileName, 'utf8')
      const jsonData = JSON.parse(rawData)
      ddos.push(jsonData)
    } catch (err) {
      OCEAN_NODE_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_WARN,
        `Error loading test DDO from ${fileName}`,
        true
      )
    }
  }
  return ddos
}

export function loadDDOSchemas(): any[] {
  const schemas: any[] = []
  const dir: string = './src/components/Indexer/shaclSchemas/v4/'
  fs.readdir(dir, (err, files) => {
    if (err) {
      console.error('Error reading directory for shacl schemas:', err)
      return
    }
    files.forEach((file) => {
      OCEAN_NODE_LOGGER.logMessage(`Loading schemas from ${file}`, true)
      const jsonSchema = getSchemasFromTtl(file)
      schemas.push(jsonSchema)
    })
  })
  return schemas
}
// (*) optional flag
const isStartup: boolean = true
// this is to avoid too much verbose logging, cause we're calling getConfig() from many parts
// and we are always running though the same process.env checks
// (we must start accessing the config from the OceanNode class only once we refactor)
console.log('\n\n\n\n')
OCEAN_NODE_LOGGER.logMessageWithEmoji(
  '[ Starting Ocean Node ]',
  true,
  GENERIC_EMOJIS.EMOJI_OCEAN_WAVE,
  LOG_LEVELS_STR.LEVEL_INFO
)
const config = await getConfig(isStartup)
if (!config) {
  process.exit(1)
}
let node: OceanP2P = null
let indexer = null
let provider = null
let dbconn = null

if (config.dbConfig?.url) {
  dbconn = await new Database(config.dbConfig)
  const customLogTransport = newCustomDBTransport(dbconn)
  OCEAN_NODE_LOGGER.addTransport(customLogTransport)
} else {
  config.hasIndexer = false
  config.hasProvider = false
}

if (config.hasP2P) {
  if (dbconn) {
    node = new OceanP2P(config, dbconn)
  } else {
    node = new OceanP2P(config)
  }
  await node.start()
}
if (config.hasIndexer && dbconn) {
  indexer = new OceanIndexer(dbconn, config.supportedNetworks)
  // load Schacl schemas for DDO validation
  loadDDOSchemas()
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
if (config.hasProvider && dbconn) {
  provider = new OceanProvider(dbconn)
}

// global
const oceanNode = new OceanNode(config, dbconn, node, provider, indexer)

if (config.hasHttp) {
  app.use(express.raw())
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
    OCEAN_NODE_LOGGER.logMessage(`HTTP port: ${config.httpPort}`, true)
  })
}
// Singleton might still useful inside the running node process
export const OceanNodeSingleton = oceanNode
