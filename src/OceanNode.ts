import { OceanNodeConfig } from './@types'
import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { Database } from './components/database/index.js'
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
import fs from 'fs'

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

  // we have 5 json examples
  // we should have some DDO class too
  public loadInitialDDOS(): any[] {
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

  public async main() {
    const config = this.getConfig()
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
    if (config.hasP2P) {
      node = new OceanP2P(dbconn, config)
      await node.start()
    }
    if (config.hasIndexer) {
      indexer = new OceanIndexer(dbconn, config.supportedNetworks)
      // if we set this var
      // it also loads initial data (useful for testing, or we might actually want to have a bootstrap list)
      // store and advertise DDOs
      if (process.env.LOAD_INITIAL_DDOS) {
        const list = this.loadInitialDDOS()
        if (list.length > 0) {
          // we need a timeout here, otherwise we have no peers available
          setTimeout(() => {
            node.storeAndAdvertiseDDOS(list)
          }, 3000)
        }
      }
    }
    if (config.hasProvider) provider = new OceanProvider(dbconn)

    return {
      node,
      indexer,
      provider
    }
  }
}
