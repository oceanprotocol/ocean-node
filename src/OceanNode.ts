import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { OceanNodeConfig, P2PCommandResponse } from './@types/OceanNode.js'
import { Database } from './components/database/index.js'
import { Escrow } from './components/core/utils/escrow.js'
import { CoreHandlersRegistry } from './components/core/handler/coreHandlersRegistry.js'
import { OCEAN_NODE_LOGGER } from './utils/logging/common.js'
import { GENERIC_EMOJIS, LOG_LEVELS_STR } from './utils/logging/Logger.js'
import { BaseHandler } from './components/core/handler/handler.js'
import { C2DEngines } from './components/c2d/compute_engines.js'
import { Auth } from './components/Auth/index.js'
import { Readable } from 'stream'

export interface RequestLimiter {
  requester: string | string[] // IP address or peer ID
  lastRequestTime: number // time of the last request done (in miliseconds)
  numRequests: number // number of requests done in the specific time period
}

export interface RequestDataCheck {
  valid: boolean
  updatedRequestData: RequestLimiter
}
export class OceanNode {
  // eslint-disable-next-line no-use-before-define
  private static instance: OceanNode
  // handlers
  private coreHandlers: CoreHandlersRegistry
  // compute engines
  private c2dEngines: C2DEngines
  // escrow
  public escrow: Escrow
  // requester
  private remoteCaller: string | string[]
  private requestMap: Map<string, RequestLimiter>
  private auth: Auth

  // eslint-disable-next-line no-useless-constructor
  private constructor(
    private config: OceanNodeConfig,
    private db?: Database,
    private node?: OceanP2P,
    private provider?: OceanProvider,
    private indexer?: OceanIndexer
  ) {
    this.coreHandlers = CoreHandlersRegistry.getInstance(this)
    this.requestMap = new Map<string, RequestLimiter>()
    this.config = config
    if (this.db && this.db?.authToken) {
      this.auth = new Auth(this.db.authToken)
    }
    if (node) {
      node.setCoreHandlers(this.coreHandlers)
    }
    if (this.config) {
      this.escrow = new Escrow(
        this.config.supportedNetworks,
        this.config.claimDurationTimeout
      )
    }
  }

  // Singleton instance
  public static getInstance(
    config?: OceanNodeConfig,
    db?: Database,
    node?: OceanP2P,
    provider?: OceanProvider,
    indexer?: OceanIndexer,
    newInstance: boolean = false
  ): OceanNode {
    if (!OceanNode.instance || newInstance) {
      // prepare compute engines
      this.instance = new OceanNode(config, db, node, provider, indexer)
    }
    return this.instance
  }

  // in the future we should remove these 'add' methods as well
  public addProvider(_provider: OceanProvider) {
    this.provider = _provider
  }

  public addIndexer(_indexer: OceanIndexer) {
    this.indexer = _indexer
  }

  public async addC2DEngines() {
    if (this.c2dEngines) {
      await this.c2dEngines.stopAllEngines()
    }
    if (this.config && this.config.c2dClusters) {
      if (!this.db || !this.db.c2d) {
        OCEAN_NODE_LOGGER.error('C2DDatabase is mandatory for compute engines!')
        return
      }
      this.c2dEngines = new C2DEngines(this.config, this.db.c2d, this.escrow)
      await this.c2dEngines.startAllEngines()
    }
  }

  public getP2PNode(): OceanP2P | undefined {
    return this.node
  }

  public getProvider(): OceanProvider | undefined {
    return this.provider
  }

  public getIndexer(): OceanIndexer | undefined {
    return this.indexer
  }

  public getDatabase(): Database {
    return this.db
  }

  public getC2DEngines(): C2DEngines {
    return this.c2dEngines
  }

  public getCoreHandlers(): CoreHandlersRegistry {
    return this.coreHandlers
  }

  public setRemoteCaller(client: string | string[]) {
    this.remoteCaller = client
  }

  public getRemoteCaller(): string | string[] {
    return this.remoteCaller
  }

  public getRequestMapSize(): number {
    return this.requestMap.size
  }

  public getRequestMap(): Map<string, RequestLimiter> {
    return this.requestMap
  }

  public getAuth(): Auth {
    return this.auth
  }

  /**
   * v3: Direct protocol command handler - no P2P, just call handler directly
   * Returns a clean {status, data} response
   * @param message - JSON command string
   */
  async handleDirectProtocolCommand(message: string): Promise<P2PCommandResponse> {
    OCEAN_NODE_LOGGER.logMessage('Incoming direct command for ocean peer', true)
    OCEAN_NODE_LOGGER.logMessage('Performing task: ' + message, true)

    try {
      const task = JSON.parse(message)
      const handler: BaseHandler = this.coreHandlers.getHandler(task.command)

      if (!handler) {
        return {
          stream: null,
          status: {
            httpStatus: 501,
            error: 'Unknown command or missing handler for: ' + task.command
          }
        }
      }

      const response: P2PCommandResponse = await handler.handle(task)

      let data: Uint8Array | undefined
      if (response.stream) {
        const chunks: Buffer[] = []
        for await (const chunk of response.stream as Readable) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        data = new Uint8Array(Buffer.concat(chunks))
      }

      if (!data) {
        return {
          stream: null,
          status: { httpStatus: 500, error: 'No data received' }
        }
      }

      return {
        status: response.status,
        stream: Readable.from(data)
      }
    } catch (err) {
      OCEAN_NODE_LOGGER.logMessageWithEmoji(
        'handleDirectProtocolCommands Error: ' + err.message,
        true,
        GENERIC_EMOJIS.EMOJI_CROSS_MARK,
        LOG_LEVELS_STR.LEVEL_ERROR
      )

      return {
        stream: null,
        status: { httpStatus: 500, error: err.message }
      }
    }
  }
}
