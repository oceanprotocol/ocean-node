import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { Database } from './components/database/index.js'
import express, { Express } from 'express'
import { OceanNode } from './OceanNode.js'
import { KeyManager } from './components/KeyManager/index.js'
import { BlockchainRegistry } from './components/BlockchainRegistry/index.js'
import { httpRoutes } from './components/httpRoutes/index.js'
import { getConfiguration, computeCodebaseHash } from './utils/index.js'

import {
  enableFileLoggingFallback,
  ensureLogOutput,
  flushLogs,
  GENERIC_EMOJIS,
  getLoggingSummary,
  LOG_LEVELS_STR,
  USE_DB_TRANSPORT
} from './utils/logging/Logger.js'
import fs from 'fs'
import https from 'https'
import { OCEAN_NODE_LOGGER } from './utils/logging/common.js'
import { redactUrls } from './utils/logging/redact.js'
import path from 'path'
import { fileURLToPath } from 'url'
import cors from 'cors'
import { scheduleCronJobs } from './utils/cronjobs/scheduleCronJobs.js'
import { requestValidator } from './components/httpRoutes/requestValidator.js'
import { isReachableConnection } from './utils/database.js'
import type { OceanNodeDBConfig } from './@types/OceanNode.js'
// Telemetry gauge registration. These modules depend on `@opentelemetry/api` only (no SDK), so
// importing them here does not pull the OTel SDK into the graph ahead of the `--import` bootstrap
// (`telemetry/otel.js`). `otel.ts` itself is loaded via `--import`, never statically imported here.
import { registerP2PGauges } from './telemetry/p2pGauges.js'
import { registerComputeGauges } from './telemetry/computeGauges.js'

const app: Express = express()

// Database services (Elasticsearch) frequently take longer to accept
// connections than the node itself takes to boot. Database.init() gives
// up after a single failed attempt, which leaves the node running permanently
// without Indexer and without C2D.

async function initDatabaseWithRetry(
  dbConfig: OceanNodeDBConfig,
  maxAttempts: number,
  retryDelay: number,
  maxRetryDelay: number
): Promise<Database | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts
    // the last attempt always calls init, so a failed probe never skips it
    const reachable = isLastAttempt || (await isReachableConnection(dbConfig.url))
    if (reachable) {
      const database = await Database.init(dbConfig)
      if (database) {
        if (attempt > 1) {
          OCEAN_NODE_LOGGER.info(`Database initialized after ${attempt} attempts`)
        }
        return database
      }
    }
    if (isLastAttempt) {
      break
    }
    const delay = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
    OCEAN_NODE_LOGGER.warn(
      `Database ${
        reachable ? 'initialization failed' : 'not reachable yet'
      } (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`
    )
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return null
}

// log the stack, then give the log files a moment to flush before exiting
let crashing = false
function exitAfterCrash(message: string, err: unknown): void {
  OCEAN_NODE_LOGGER.error(
    `${message}: ${redactUrls(
      err instanceof Error ? err.stack || err.message : String(err)
    )}`
  )
  if (crashing) return
  crashing = true
  void flushLogs().finally(() => process.exit(1))
}
process.on('uncaughtException', (err) => {
  exitAfterCrash('Uncaught exception', err)
})
process.on('unhandledRejection', (err) => {
  exitAfterCrash('Unhandled rejection', err)
})

// Graceful shutdown: flush the final telemetry batch before exiting so a deploy does not lose the
// last export. The OTel SDK is only present in the module cache when loaded via `--import`, so this
// resolves `shutdownTelemetry()` lazily and is a harmless no-op when telemetry is unconfigured.
// A re-entrancy guard makes a second signal (e.g. double Ctrl-C) a no-op, and a force-exit timer
// guarantees the process still dies if the OTLP flush stalls against an unreachable collector —
// so adding these handlers never makes shutdown slower than the previous signal-kills-immediately
// behavior.
let shuttingDown = false
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  OCEAN_NODE_LOGGER.info(`Received ${signal}, shutting down`)
  const forceExit = setTimeout(() => {
    OCEAN_NODE_LOGGER.warn('Shutdown timed out, forcing exit')
    process.exit(1)
  }, 10000)
  forceExit.unref()
  try {
    await (await import('./telemetry/otel.js')).shutdownTelemetry()
  } catch (e) {
    OCEAN_NODE_LOGGER.error(
      `Telemetry shutdown failed: ${e instanceof Error ? e.message : e}`
    )
  }
  await flushLogs()
  clearTimeout(forceExit)
  process.exit(0)
}
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})

// const port = getRandomInt(6000,6500)

declare global {
  // eslint-disable-next-line no-unused-vars
  namespace Express {
    // eslint-disable-next-line no-unused-vars
    interface Request {
      oceanNode: OceanNode
      caller?: string | string[]
    }
  }
}

// (*) optional flag
const isStartup: boolean = true
// this is to avoid too much verbose logging, cause we're calling getConfig() from many parts
// and we are always running though the same process.env checks
// (we must start accessing the config from the OceanNode class only once we refactor)
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
const dbconn: Database | null = await initDatabaseWithRetry(
  config.dbConfig,
  config.dbInitMaxAttempts,
  config.dbInitRetryDelay,
  config.dbInitMaxRetryDelay
)
if (!dbconn) {
  OCEAN_NODE_LOGGER.error('Database failed to initialize')
}

// LOG_DB is on but there is no usable log database (failed init): keep the logs on disk instead
if (USE_DB_TRANSPORT() && !dbconn?.logs) {
  const reason = dbconn ? 'log DB not initialized' : 'DB init failed'
  // LOG_FILES=false as well: never leave the node without any log output
  if (!enableFileLoggingFallback(reason)) ensureLogOutput(reason)
}
OCEAN_NODE_LOGGER.info(getLoggingSummary())

// Create KeyManager and BlockchainRegistry
// KeyManager will determine provider type from config.keys.type and initialize in constructor
const keyManager = new KeyManager(config)
const blockchainRegistry = new BlockchainRegistry(keyManager, config)

if (config.hasP2P) {
  if (dbconn) {
    node = new OceanP2P(config, keyManager, dbconn)
  } else {
    node = new OceanP2P(config, keyManager)
  }
  await node.start()
  // Attach the P2P observable-gauge callbacks now that libp2p is up. No-ops cleanly if P2P is
  // disabled (this block only runs when hasP2P) or when telemetry is unconfigured.
  registerP2PGauges(node)
}
if (config.hasIndexer && dbconn) {
  indexer = new OceanIndexer(dbconn, config, blockchainRegistry)
}
if (dbconn) {
  provider = new OceanProvider(dbconn)
}

// Singleton instance across application
const oceanNode = OceanNode.getInstance(
  config,

  dbconn,
  node,
  provider,
  indexer,
  keyManager,
  blockchainRegistry
)
// Load the persisted maintenance (drain) flag into the in-memory cache (and apply the
// MAINTENANCE_MODE env override if set) BEFORE engines come up, to minimize the startup
// window in which an early P2P command could be dispatched before the flag is loaded.
// Guards internally for a missing config DB.
await oceanNode.loadMaintenanceMode()
await oceanNode.addC2DEngines()
// Attach the compute observable-gauge callbacks. No-ops cleanly when C2D is disabled
// (getC2DEngines() is undefined) or when telemetry is unconfigured.
registerComputeGauges(oceanNode.getC2DEngines())

function removeExtraSlashes(req: any, res: any, next: any) {
  req.url = req.url.replace(/\/{2,}/g, '/')
  next()
}

if (config.hasHttp) {
  // Controls how req.ip / req.caller are derived from the connection and X-Forwarded-For.
  // Default (false) ignores the client-supplied header and uses the real socket peer, so a
  // client cannot spoof its address to evade rate limiting or the deny list. Operators who
  // terminate behind a trusted reverse proxy set TRUST_PROXY (e.g. 1, 'loopback', or a
  // CIDR list) so Express resolves the real client IP from the trusted hops only.
  app.set('trust proxy', config.trustProxy ?? false)
  app.use(cors())
  app.use((req, res, next) => {
    // req.ip respects the `trust proxy` setting above (see requestValidator for details). The
    // `|| ''` fallback (matching requestValidator) guarantees a defined string: otherwise an
    // undefined req.caller would make handleDirectProtocolCommand's `caller !== undefined` guard
    // skip the override and fall back to trusting a client-supplied body `caller`.
    req.caller = req.ip || req.socket.remoteAddress || ''
    req.oceanNode = oceanNode
    // Express 4 left req.body as {} when there was nothing to parse; Express 5 leaves
    // it undefined, which turns every `req.body.x` read and `const {x} = req.body`
    // in the route handlers into a TypeError. Seeding it here restores the Express 4
    // shape for the whole app. body-parser still parses normally: it only resets
    // req.body when the property is absent, and assigns unconditionally on success.
    if (req.body === undefined) {
      req.body = {}
    }
    next()
  }, requestValidator)

  app.use(removeExtraSlashes)
  app.use('/', httpRoutes)

  let httpsStarted = false
  if (config.httpCertPath && config.httpKeyPath) {
    try {
      const options = {
        cert: fs.readFileSync(config.httpCertPath),
        key: fs.readFileSync(config.httpKeyPath)
      }
      https.createServer(options, app).listen(config.httpPort, () => {
        OCEAN_NODE_LOGGER.info(`HTTPS server listening on port ${config.httpPort}`)
      })
      httpsStarted = true
    } catch (err) {
      OCEAN_NODE_LOGGER.error(
        `Error starting HTTPS server, falling back to HTTP: ${err.message}`
      )
    }
  }
  if (!httpsStarted) {
    app.listen(config.httpPort, () => {
      OCEAN_NODE_LOGGER.info(`HTTP server listening on port ${config.httpPort}`)
    })
  }

  // Call the function to schedule the cron job to delete old logs
  scheduleCronJobs(oceanNode)
}
