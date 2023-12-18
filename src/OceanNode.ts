import { OceanP2P } from './components/P2P/index.js'
import { OceanProvider } from './components/Provider/index.js'
import { OceanIndexer } from './components/Indexer/index.js'
import { OceanNodeConfig } from './@types/OceanNode.js'
import { Database } from './components/database/index.js'
import {
  Command,
  PROTOCOL_COMMANDS,
  SUPPORTED_PROTOCOL_COMMANDS
} from './utils/constants.js'
import {
  CustomNodeLogger,
  LOGGER_MODULE_NAMES,
  LOG_LEVELS_STR,
  defaultConsoleTransport,
  getCustomLoggerForModule
} from './utils/logging/Logger.js'

export const OCEAN_NODE_LOGGER: CustomNodeLogger = getCustomLoggerForModule(
  LOGGER_MODULE_NAMES.OCEAN_NODE,
  LOG_LEVELS_STR.LEVEL_INFO, // Info level
  defaultConsoleTransport // console only Transport
)

// placeholder, replace with final handler class
abstract class Handler {
  // eslint-disable-next-line no-useless-constructor
  public constructor() {}
}

export type HandlerRegistry = {
  handlerName: string // name of the handler
  handlerImpl: Handler // class that implements it
}

export class OceanNode {
  private coreHandlers: Map<string, Handler> = new Map<string, Handler>()
  public constructor(
    private config: OceanNodeConfig,
    private db: Database,
    private node?: OceanP2P,
    private provider?: OceanProvider,
    private indexer?: OceanIndexer
  ) {
    // TODO: Implement handlers classes and change above
    this.registerHandler(PROTOCOL_COMMANDS.DOWNLOAD, null)
    this.registerHandler(PROTOCOL_COMMANDS.DOWNLOAD_URL, null)
    this.registerHandler(PROTOCOL_COMMANDS.ENCRYPT, null)
    this.registerHandler(PROTOCOL_COMMANDS.NONCE, null)
    this.registerHandler(PROTOCOL_COMMANDS.GET_DDO, null)
    this.registerHandler(PROTOCOL_COMMANDS.QUERY, null)
    this.registerHandler(PROTOCOL_COMMANDS.STATUS, null)
    this.registerHandler(PROTOCOL_COMMANDS.FIND_DDO, null)
    this.registerHandler(PROTOCOL_COMMANDS.GET_FEES, null)
    /**
   * 
  PROTOCOL_COMMANDS.DOWNLOAD_URL,
  PROTOCOL_COMMANDS.ECHO,
  PROTOCOL_COMMANDS.ENCRYPT,
  PROTOCOL_COMMANDS.NONCE,
  PROTOCOL_COMMANDS.GET_DDO,
  PROTOCOL_COMMANDS.QUERY,
  PROTOCOL_COMMANDS.STATUS,
  PROTOCOL_COMMANDS.FIND_DDO,
  PROTOCOL_COMMANDS.GET_FEES
   */
  }

  public addP2PNode(_node: OceanP2P) {
    this.node = _node
  }

  public addProvider(_provider: OceanProvider) {
    this.provider = _provider
  }

  public addIndexer(_indexer: OceanIndexer) {
    this.indexer = _indexer
  }

  public getConfig(): OceanNodeConfig {
    return this.config
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

  // any new Handlers just need to call this method
  private registerHandler(handlerName: string, handlerObj: Handler) {
    if (!this.coreHandlers.has(handlerName)) {
      this.coreHandlers.set(handlerName, handlerObj)
    }
  }

  // or this one
  public registerCoreHandler(handler: HandlerRegistry) {
    if (
      !this.coreHandlers.has(handler.handlerName) &&
      handler.handlerImpl instanceof Handler
    ) {
      this.coreHandlers.set(handler.handlerName, handler.handlerImpl)
    }
  }

  // pass the handler name from the SUPPORTED_PROTOCOL_COMMANDS keys
  public getHandler(handlerName: string): Handler {
    if (!SUPPORTED_PROTOCOL_COMMANDS.includes(handlerName)) {
      const msg = `Invalid handler "${handlerName}". No known associated protocol command!`
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    } else if (!this.coreHandlers.has(handlerName)) {
      const msg = `No handler registered for "${handlerName}". Did you forgot to call "registerHandler()" ?`
      // TODO: we can also just log the warning and create a new handler ourselfes here
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    }
    return this.coreHandlers.get(handlerName)
  }

  public getHandlerForTask(task: Command): Handler | undefined {
    return this.getHandler(task.command)
  }

  public hasHandlerFor(handlerName: string): boolean {
    return this.coreHandlers.has(handlerName)
  }
}

export class HandlerFactory {
  static buildHandlerForTask(task: Command): HandlerRegistry {
    if (SUPPORTED_PROTOCOL_COMMANDS.includes(task.command)) {
      return {
        handlerName: task.command,
        handlerImpl: undefined // TODO: create instance, new HandlerImplXYZ(...)
      }
    } else {
      const msg = `Invalid handler "${task.command}". No known associated protocol command!`
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    }
  }
}
