import { OceanNodeConfig } from './@types'
import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { Database } from './components/database/index.js'
import { Blockchain } from './utils/blockchain.js'
import { RPCS } from './@types/blockchain.js'
import {
  CustomNodeLogger,
  GENERIC_EMOJIS,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from './utils/logging/Logger.js'
import express, { Express } from 'express'
import swaggerUi from 'swagger-ui-express'
import { httpRoutes } from './components/httpRoutes/index.js'

const app: Express = express()

const logger: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.HTTP,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)
export class OceanNode {
  private config: OceanNodeConfig
  private oceanNode: any
  public constructor(config: OceanNodeConfig) {
    if (!this.validateEnv()) {
      return null
    }
    this.config = config
    this.oceanNode = Promise.resolve(this.main()).then((node) => {
      return node
    })
    if (this.config.hasHttp) {
      app.use((req, res, next) => {
        req.oceanNode = this.oceanNode
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
      app.listen(this.config.httpPort, () => {
        logger.logMessage(`HTTP port: ${config.httpPort}`, true)
      })
    }
  }

  public getConfig(): OceanNodeConfig {
    return this.config
  }

  public getOceanNode(): any {
    return this.oceanNode
  }

  public validateEnv(): boolean {
    const privateKey = process.env.PRIVATE_KEY
    if (!privateKey || privateKey.length !== 66) {
      // invalid private key
      logger.logMessageWithEmoji(
        'Invalid PRIVATE_KEY env variable..',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEl_ERROR
      )
      return false
    }

    if (!process.env.IPFS_GATEWAY) {
      logger.logMessageWithEmoji(
        'Invalid IPFS_GATEWAY env variable..',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEl_ERROR
      )
      return false
    }

    if (!process.env.ARWEAVE_GATEWAY) {
      logger.logMessageWithEmoji(
        'Invalid ARWEAVE_GATEWAY env variable..',
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEl_ERROR
      )
      return false
    }
    return true
  }

  public async main() {
    const config = this.getConfig()
    let node = null
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
    console.log('supportedNetworks', supportedNetworks)
    const blockchain = new Blockchain(supportedNetworks, config.keys)
    if (config.hasP2P) {
      node = new OceanP2P(dbconn, config)
      await node.start()
    }
    if (config.hasIndexer) indexer = new OceanIndexer(dbconn)
    if (config.hasProvider) provider = new OceanProvider(dbconn)

    return {
      node,
      indexer,
      provider,
      blockchain
    }
  }
}
