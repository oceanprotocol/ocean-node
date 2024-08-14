import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { Database } from './components/database/index.js'
import express, { Express } from 'express'
import { OceanNode } from './OceanNode.js'
import { httpRoutes } from './components/httpRoutes/index.js'
import { getConfiguration, computeCodebaseHash } from './utils/index.js'

import { GENERIC_EMOJIS, LOG_LEVELS_STR } from './utils/logging/Logger.js'
import fs from 'fs'
import { OCEAN_NODE_LOGGER } from './utils/logging/common.js'
import path from 'path'
import { fileURLToPath } from 'url'
import cors from 'cors'
import { scheduleCronJobs } from './utils/logging/logDeleteCron.js'
import { requestValidator } from './components/httpRoutes/requestValidator.js'

const app: Express = express()

// const port = getRandomInt(6000,6500)

express.static.mime.define({ 'image/svg+xml': ['svg'] })

declare global {
  // eslint-disable-next-line no-unused-vars
  namespace Express {
    // eslint-disable-next-line no-unused-vars
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

const config = await getConfiguration(true, isStartup)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
config.codeHash = await computeCodebaseHash(__dirname)

OCEAN_NODE_LOGGER.info(`Codebase hash: ${config.codeHash}`)
if (!config) {
  process.exit(1)
}
let node: OceanP2P = null
let indexer = null
let provider = null
let dbconn: Database | null = null

if (config.dbConfig?.url) {
  // once we create a database instance, we check the environment and possibly add the DB transport
  // after that, all loggers will eventually have it too (if in production/staging environments)
  // it creates dinamically DDO schemas
  dbconn = await new Database(config.dbConfig)
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
  indexer = new OceanIndexer(dbconn, config.indexingNetworks)
  // if we set this var
  // it also loads initial data (useful for testing, or we might actually want to have a bootstrap list)
  // store and advertise DDOs
  if (process.env.LOAD_INITIAL_DDOS && config.hasP2P) {
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

// Singleton instance across application
const oceanNode = OceanNode.getInstance(dbconn, node, provider, indexer, config)

function removeExtraSlashes(req: any, res: any, next: any) {
  req.url = req.url.replace(/\/{2,}/g, '/')
  next()
}

if (config.hasHttp) {
  // allow up to 25Mb file upload
  app.use(express.raw({ limit: '25mb' }))
  app.use(cors())

  if (config.hasDashboard) {
    // Serve static files expected at the root, under the '/_next' path
    app.use('/_next', express.static(path.join(__dirname, '/dashboard/_next')))

    // Serve static files for Next.js under '/dashboard'
    const dashboardPath = path.join(__dirname, '/dashboard')
    app.use('/dashboard', express.static(dashboardPath))

    // Custom middleware for SPA routing: Serve index.html for non-static asset requests under '/dashboard'
    app.use('/dashboard', (req, res, next) => {
      if (/(.ico|.js|.css|.jpg|.png|.svg|.map)$/i.test(req.path)) {
        return next() // Skip this middleware if the request is for a static asset
      }

      // For any other requests under '/dashboard', serve index.html
      res.sendFile(path.join(dashboardPath, 'index.html'))
    })
  }

  app.use(requestValidator, (req, res, next) => {
    oceanNode.setRemoteCaller(req.headers['x-forwarded-for'] || req.socket.remoteAddress)
    req.oceanNode = oceanNode
    next()
  })

  // Integrate static file serving middleware
  app.use(removeExtraSlashes)
  app.use('/', httpRoutes)

  app.listen(config.httpPort, () => {
    OCEAN_NODE_LOGGER.logMessage(`HTTP port: ${config.httpPort}`, true)
  })

  // Call the function to schedule the cron job to delete old logs
  scheduleCronJobs(dbconn)
}
