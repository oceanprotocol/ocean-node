import {
  Command,
  PROTOCOL_COMMANDS,
  SUPPORTED_PROTOCOL_COMMANDS
} from '../../utils/constants.js'
import { OCEAN_NODE_LOGGER } from '../../utils/logging/common.js'
import { GetDdoHandler, FindDdoHandler } from './ddoHandler.js'
import { DownloadHandler } from './downloadHandler.js'
import { FileInfoHandler } from './fileInfoHandler.js'
import { EchoHandler } from './echoHandler.js'
import { EncryptHandler } from './encryptHandler.js'
import { FeesHandler } from './feesHandler.js'
import { Handler } from './handler.js'
import { NonceHandler } from './nonceHandler.js'
import { QueryHandler } from './queryHandler.js'
import { StatusHandler } from './statusHandler.js'
import { OceanP2P } from '../P2P/index.js'
import { ReindexHandler } from './reindexHandler.js'

export type HandlerRegistry = {
  handlerName: string // name of the handler
  handlerImpl: Handler // class that implements it
}

// we can use this factory class to create adittional handlers
// and then register them on the Ocean Node instance
export class HandlerFactory {
  static buildHandlerForTask(task: Command, impl: Handler): HandlerRegistry {
    if (!task || !impl) {
      const msg = 'Invalid task/handler parameters!'
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    } else if (SUPPORTED_PROTOCOL_COMMANDS.includes(task.command)) {
      return {
        handlerName: task.command,
        handlerImpl: impl
      }
    } else {
      const msg = `Invalid handler "${task.command}". No known associated protocol command!`
      OCEAN_NODE_LOGGER.error(msg)
      throw new Error(msg)
    }
  }
}

// this should be used as singleton
export class CoreHandlersRegistry {
  // eslint-disable-next-line no-use-before-define
  private static instance: CoreHandlersRegistry
  // map of handlers registered
  private coreHandlers: Map<string, Handler> = new Map<string, Handler>()
  // private readonly node: OceanP2P
  private constructor(node: OceanP2P) {
    // implement core handlers
    this.registerCoreHandler(PROTOCOL_COMMANDS.DOWNLOAD, new DownloadHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ENCRYPT, new EncryptHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.NONCE, new NonceHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_DDO, new GetDdoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.QUERY, new QueryHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.STATUS, new StatusHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.FIND_DDO, new FindDdoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.GET_FEES, new FeesHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.ECHO, new EchoHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.REINDEX, new ReindexHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.NONCE, new NonceHandler(node))
    this.registerCoreHandler(PROTOCOL_COMMANDS.FILE_INFO, new FileInfoHandler(node))
  }

  public static getInstance(node: OceanP2P): CoreHandlersRegistry {
    if (!CoreHandlersRegistry.instance) {
      this.instance = new CoreHandlersRegistry(node)
    }
    return this.instance
  }

  // supported commands:
  // PROTOCOL_COMMANDS.DOWNLOAD_URL,
  // PROTOCOL_COMMANDS.ECHO,
  // PROTOCOL_COMMANDS.ENCRYPT,
  // PROTOCOL_COMMANDS.NONCE,
  // PROTOCOL_COMMANDS.GET_DDO,
  // PROTOCOL_COMMANDS.QUERY,
  // PROTOCOL_COMMANDS.STATUS,
  // PROTOCOL_COMMANDS.FIND_DDO,
  // PROTOCOL_COMMANDS.GET_FEES

  // private method for registering the core handlers
  private registerCoreHandler(handlerName: string, handlerObj: Handler) {
    if (!this.coreHandlers.has(handlerName)) {
      this.coreHandlers.set(handlerName, handlerObj)
    }
  }

  // any new Handlers just need to call this method
  public registerHandler(handler: HandlerRegistry) {
    if (
      !this.coreHandlers.has(handler.handlerName) &&
      handler.handlerImpl instanceof Handler
    ) {
      this.coreHandlers.set(handler.handlerName, handler.handlerImpl)
    }
  }

  // pass the handler name from the SUPPORTED_PROTOCOL_COMMANDS keys
  public getHandler(handlerName: string): Handler | null {
    if (!SUPPORTED_PROTOCOL_COMMANDS.includes(handlerName)) {
      OCEAN_NODE_LOGGER.error(
        `Invalid handler "${handlerName}". No known associated protocol command!`
      )
      return null
    } else if (!this.coreHandlers.has(handlerName)) {
      // TODO: we can also just log the warning and create a new handler ourselfes here
      OCEAN_NODE_LOGGER.error(
        `No handler registered for "${handlerName}". Did you forgot to call "registerHandler()" ?`
      )
      return null
    }
    return this.coreHandlers.get(handlerName)
  }

  public getHandlerForTask(task: Command): Handler | null {
    return this.getHandler(task.command)
  }

  public hasHandlerFor(handlerName: string): boolean {
    return this.coreHandlers.has(handlerName)
  }
}
